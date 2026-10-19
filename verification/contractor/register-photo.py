"""Content-only photo registration. Never accepts a watermark key or candidate ID."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat

os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "16000000"
MAX_BYTES = 64 * 1024 * 1024


def read_image(path, cv):
    # Do not follow a symlink or accept a special file. Bound decoding first.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
            raise ValueError("Expected a regular image of at most 64 MiB")
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Image exceeds 64 MiB")
    import numpy as np
    image = cv.imdecode(np.frombuffer(data, np.uint8), cv.IMREAD_COLOR)
    if image is None or not 4096 <= image.shape[0] * image.shape[1] <= 16_000_000:
        raise ValueError("Image must contain 4096..16000000 pixels")
    return image, hashlib.sha256(data).hexdigest()


def register(reference_path, photo_path):
    import cv2 as cv
    import numpy as np
    cv.setNumThreads(1)
    cv.setRNGSeed(0)
    reference, reference_hash = read_image(reference_path, cv)
    photo, photo_hash = read_image(photo_path, cv)

    def small(image):
        scale = min(1, 1200 / max(image.shape[:2]))
        resized = cv.resize(image, None, fx=scale, fy=scale, interpolation=cv.INTER_AREA)
        return cv.cvtColor(resized, cv.COLOR_BGR2GRAY), scale

    ref, ref_scale = small(reference)
    capture, photo_scale = small(photo)
    # Preserve the established path. Dense repeated text gets a bounded retry
    # only when its geometry fails, with no key or detection score involved.
    for feature_count, estimator, iterations in [(2500, cv.RANSAC, 3000), (8000, cv.USAC_MAGSAC, 10000)]:
        sift = cv.SIFT_create(nfeatures=feature_count)
        ref_keys, ref_des = sift.detectAndCompute(ref, None)
        photo_keys, photo_des = sift.detectAndCompute(capture, None)
        if ref_des is None or photo_des is None:
            continue
        pairs = cv.BFMatcher().knnMatch(ref_des, photo_des, k=2)
        matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.7 * pair[1].distance]
        if len(matches) < 40:
            continue
        source = np.float32([ref_keys[item.queryIdx].pt for item in matches])
        target = np.float32([photo_keys[item.trainIdx].pt for item in matches])
        matrix, mask = cv.findHomography(source, target, estimator, 2, maxIters=iterations, confidence=0.999)
        if matrix is None or mask is None or int(mask.sum()) < 30 or mask.mean() < 0.25:
            continue
        inliers = source[mask.ravel().astype(bool)]
        if np.ptp(inliers[:, 0]) >= ref.shape[1] * 0.35 and np.ptp(inliers[:, 1]) >= ref.shape[0] * 0.35:
            break
    else:
        raise ValueError("No reliable content homography")
    hypotheses = [("sift", matrix.copy())]
    quality = None
    try:
        quality, refined = cv.findTransformECC(ref, capture, matrix.astype(np.float32), cv.MOTION_HOMOGRAPHY,
            (cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 150, 1e-7), None, 5)
        if quality >= 0.4:
            hypotheses.append(("ecc", refined))
    except cv.error:
        pass
    records = []
    images = []
    for method, transform in hypotheses:
        full = np.diag([1 / photo_scale, 1 / photo_scale, 1]) @ transform @ np.diag([ref_scale, ref_scale, 1])
        full /= full[2, 2]
        height, width = reference.shape[:2]
        corners = np.float32([[[0, 0], [width, 0], [width, height], [0, height]]])
        projected = cv.perspectiveTransform(corners, full)[0]
        if not np.isfinite(full).all() or not np.isfinite(projected).all() or not cv.isContourConvex(projected):
            raise ValueError("Invalid photo geometry")
        area = abs(cv.contourArea(projected))
        if not photo.shape[0] * photo.shape[1] * 0.1 <= area <= photo.shape[0] * photo.shape[1] * 4:
            raise ValueError("Unreasonable photo geometry")
        coverage = cv.warpPerspective(np.full(photo.shape[:2], 255, np.uint8), np.linalg.inv(full),
            (width, height), flags=cv.INTER_NEAREST)
        if np.count_nonzero(coverage) < width * height * 0.5:
            raise ValueError("Less than half the reference page is visible")
        # Only photograph pixels are resampled. No reference pixels are copied.
        warped = cv.warpPerspective(photo, np.linalg.inv(full), (width, height),
            flags=cv.INTER_LINEAR, borderValue=(255, 255, 255))
        success, encoded = cv.imencode(".png", warped)
        if not success:
            raise ValueError("Cannot encode registered photo")
        images.append((method, encoded.tobytes()))
        records.append({"method": method, "homography": full.tolist(), "visibleFraction": float(np.count_nonzero(coverage) / coverage.size)})
    report = {"format": "privcloud-content-registration-v1", "referenceSha256": reference_hash,
        "photoSha256": photo_hash, "opencvVersion": cv.__version__, "inliers": int(mask.sum()),
        "contentMatches": len(matches), "eccQuality": quality, "hypotheses": records,
        "limits": "Requires the correct unmarked reference raster. Analyse ALL outputs together. Not calibrated for production attribution."}
    return report, images


def write_registration(report, images):
    # No command-line value becomes a path component. token_hex returns exactly
    # lowercase hexadecimal characters, so separators and dot segments are impossible.
    directory = secrets.token_hex(16)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.open(".", directory_flags)
    try:
        try:
            os.mkdir("photo-registrations", mode=0o700, dir_fd=current)
        except FileExistsError:
            pass
        parent = os.open("photo-registrations", directory_flags, dir_fd=current)
        try:
            os.mkdir(directory, mode=0o700, dir_fd=parent)
            destination = os.open(directory, directory_flags, dir_fd=parent)
            try:
                fixed_images = {"sift": "sift.png", "ecc": "ecc.png"}
                for method, data in images:
                    filename = fixed_images.get(method)
                    if filename is None:
                        raise ValueError("Unexpected registration method")
                    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600, dir_fd=destination)
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(data)
                descriptor = os.open("registration.json",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=destination)
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    json.dump(report, stream, indent=2, allow_nan=False)
                    stream.write("\n")
            finally:
                os.close(destination)
        finally:
            os.close(parent)
    finally:
        os.close(current)
    return "photo-registrations/" + directory


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--photo", required=True, type=Path)
    args = parser.parse_args()
    try:
        result, images = register(args.reference, args.photo)
        output = write_registration(result, images)
        print(json.dumps({"hypotheses": len(result["hypotheses"]), "inliers": result["inliers"], "output": output}))
    except (ValueError, OSError, ImportError) as error:
        parser.exit(2, "Photo registration failed: " + str(error) + "\n")
