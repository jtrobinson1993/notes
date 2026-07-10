# v8 key-transparency sidecar (akd). Multi-stage: build the release binary, then
# ship it on a slim runtime. Reachable only on the compose network (no published
# port) and authenticated by AKD_SIDECAR_TOKEN.
FROM rust:1-bookworm AS build
WORKDIR /build
# Cache deps: copy manifests first, fetch, then the source.
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release --locked || cargo build --release
RUN cp target/release/akd-sidecar /akd-sidecar

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 akd && mkdir -p /akd-data && chown akd /akd-data
COPY --from=build /akd-sidecar /usr/local/bin/akd-sidecar
USER akd
ENV AKD_SIDECAR_HOST=0.0.0.0 AKD_SIDECAR_PORT=8091 AKD_SIDECAR_DATA=/akd-data
EXPOSE 8091
ENTRYPOINT ["akd-sidecar"]
