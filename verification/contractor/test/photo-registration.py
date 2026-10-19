"""Optional image registration regression suite, run with requirements-photo.txt."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cv2 as cv
import numpy as np

spec = importlib.util.spec_from_file_location("registration", Path(__file__).parent.parent / "register-photo.py")
registration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registration)


class PhotoRegistration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="privcloud-photo-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.reference = np.full((1000, 750, 3), 240, np.uint8)
        rng = np.random.default_rng(91873)
        for index in range(30):
            text = "Sample " + str(index) + " " + str(rng.integers(10000, 99999)) + " independent content " + str(rng.integers(1000, 9999))
            cv.putText(self.reference, text, (30, 35 + index * 30), cv.FONT_HERSHEY_SIMPLEX, 0.65, (25, 25, 25), 2)
        cv.imwrite(str(self.root / "reference.png"), self.reference)
        matrix = cv.getPerspectiveTransform(np.float32([[0, 0], [750, 0], [750, 1000], [0, 1000]]),
            np.float32([[80, 60], [850, 110], [780, 1180], [45, 1100]]))
        # Different brightness means copying source pixels would fail this check.
        self.photo = cv.warpPerspective(self.reference - 15, matrix, (950, 1250), borderValue=(10, 10, 10))
        cv.imwrite(str(self.root / "photo.png"), self.photo)

    def test_recovers_content_without_copying_reference(self):
        result, images = registration.register(self.root / "reference.png", self.root / "photo.png")
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            relative = registration.write_registration(result, images)
        finally:
            os.chdir(previous)
        output = self.root / relative
        self.assertGreaterEqual(result["inliers"], 30)
        for hypothesis in result["hypotheses"]:
            image = cv.imread(str(output / (hypothesis["method"] + ".png")))
            self.assertEqual(image.shape, self.reference.shape)
            self.assertLess(float(image[100:900, 100:650].mean()), float(self.reference[100:900, 100:650].mean()) - 5)
            self.assertGreater(hypothesis["visibleFraction"], 0.9)

    def test_wrong_reference_is_rejected(self):
        cv.imwrite(str(self.root / "wrong.png"), np.full((1000, 750, 3), 255, np.uint8))
        with self.assertRaises(ValueError):
            registration.register(self.root / "wrong.png", self.root / "photo.png")
        self.assertFalse((self.root / "photo-registrations").exists())

    def test_symlink_and_existing_output_are_rejected(self):
        (self.root / "symlink.png").symlink_to(self.root / "photo.png")
        with self.assertRaises(OSError):
            registration.read_image(self.root / "symlink.png", cv)
        result, images = registration.register(self.root / "reference.png", self.root / "photo.png")
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.object(registration.secrets, "token_hex", return_value="1" * 32):
                relative = registration.write_registration(result, images)
                with self.assertRaises(FileExistsError):
                    registration.write_registration(result, images)
            self.assertRegex(relative, r"^photo-registrations/[a-f0-9]{32}$")
        finally:
            os.chdir(previous)

    def test_output_root_symlink_is_rejected(self):
        result, images = registration.register(self.root / "reference.png", self.root / "photo.png")
        work = self.root / "work"
        outside = self.root / "outside"
        work.mkdir()
        outside.mkdir()
        (work / "photo-registrations").symlink_to(outside, target_is_directory=True)
        previous = Path.cwd()
        try:
            os.chdir(work)
            with self.assertRaises(OSError):
                registration.write_registration(result, images)
        finally:
            os.chdir(previous)
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
