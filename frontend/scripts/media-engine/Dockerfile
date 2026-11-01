# Builds the WebAssembly media engine of public/video-decoders/media/: FFmpeg
# demuxers and decoders through libav.js, LGPL only (no GPL or nonfree part),
# plain WebAssembly without threads. Run by scripts/build-media-engine.mjs,
# which checks the source archives before they reach this context. The build
# itself runs without network.
FROM emscripten/emsdk:6.0.7@sha256:71190e58eab340c692c0c3bb9741705f5c9625766a561c906dc6c01b1ed6d761 AS build
# Compiled by the unprivileged user of the image, owner of the emcc cache.
RUN mkdir /libav.js /out && chown ubuntu:ubuntu /libav.js /out
USER ubuntu
WORKDIR /libav.js
COPY libav.js.tar.gz ffmpeg.tar.xz emfiberthreads.tar.gz variant.json /sources/
RUN echo "3b640c356d74724a99230b077ef442d8c995a37c03e0729d6d2a9be0f3a41fd3  /sources/libav.js.tar.gz" | sha256sum -c - \
    && echo "7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52  /sources/ffmpeg.tar.xz" | sha256sum -c - \
    && echo "0fe933d7742de3b3213608e0fb087a1ae0d060604d5835f7c9cdfcee0fc8cbcb  /sources/emfiberthreads.tar.gz" | sha256sum -c - \
    && tar xzf /sources/libav.js.tar.gz --strip-components=1 \
    && mkdir -p build node_modules/.bin \
    && cp /sources/ffmpeg.tar.xz build/ffmpeg-9.0.tar.xz \
    && cp /sources/emfiberthreads.tar.gz build/emfiberthreads-1.3.tar.gz \
    && touch node_modules/.bin/terser \
    && cd configs && node mkconfig.js privcloud "$(cat /sources/variant.json)"
RUN make MINIFIER=cat \
    dist/libav-6.10.9.0-privcloud.mjs \
    dist/libav-6.10.9.0-privcloud.wasm.mjs \
    && cp dist/libav-6.10.9.0-privcloud.mjs dist/libav-6.10.9.0-privcloud.wasm.mjs \
       dist/libav-6.10.9.0-privcloud.wasm.wasm /out/ \
    && cp LICENSE.md /out/LIBAVJS_LICENSE.md \
    && cp build/ffmpeg-9.0/COPYING.LGPLv2.1 /out/FFMPEG_COPYING.LGPLv2.1 \
    && grep -q '^#define CONFIG_GPL 0$' build/ffmpeg-9.0/build-base-privcloud/config.h \
    && grep -q '^#define CONFIG_NONFREE 0$' build/ffmpeg-9.0/build-base-privcloud/config.h

# Files only, exported with --output: never run, owned by no one, and with
# no process whose health could be probed.
FROM scratch
COPY --from=build /out/ /
USER 65534:65534
HEALTHCHECK NONE
