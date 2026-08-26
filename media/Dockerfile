FROM node:22-bookworm-slim AS node-runtime

FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates libatomic1 \
    && useradd --create-home --uid 10001 media \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp's EJS challenge solver requires an external JavaScript runtime.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/LICENSE /usr/local/share/licenses/node/LICENSE

COPY pyproject.toml ./
COPY src ./src
COPY THIRD_PARTY_NOTICES.md /usr/local/share/doc/dreamstream-media/THIRD_PARTY_NOTICES.md

ARG YTDLP_PLUGIN_PACKAGE=""

RUN python -m pip install --upgrade pip \
    && python -m pip install . \
    && if [ -n "$YTDLP_PLUGIN_PACKAGE" ]; then \
        python -m pip install "$YTDLP_PLUGIN_PACKAGE"; \
    fi \
    && mkdir -p /usr/local/share/licenses/bgutil-ytdlp-pot-provider \
    && cp /usr/share/common-licenses/GPL-3 \
        /usr/local/share/licenses/bgutil-ytdlp-pot-provider/LICENSE \
    && node --version \
    && python -c "from importlib.metadata import version; assert version('yt-dlp') == '2026.8.19'; assert version('yt-dlp-ejs') == '0.8.0'"

USER media

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"]

CMD ["uvicorn", "media_service.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
