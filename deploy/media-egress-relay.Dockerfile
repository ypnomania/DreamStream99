FROM alpine:3.22.5@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache socat=1.8.1.3-r0 \
    && socat -V 2>&1 | grep -F "version 1.8.1.3"

USER 10001:10001

ENTRYPOINT ["socat"]
