FROM node:22-bookworm-slim AS website
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
COPY web/vendor ./vendor
RUN npm ci --no-audit --no-fund
COPY config /build/config
COPY contracts /build/contracts
COPY scripts /build/scripts
COPY jobs_radar/saved_response_contract.json /build/jobs_radar/saved_response_contract.json
COPY jobs_radar/profile.schema.json /build/jobs_radar/profile.schema.json
COPY jobs_radar/answer-policy.json /build/jobs_radar/answer-policy.json
COPY jobs_radar/application-stages.json /build/jobs_radar/application-stages.json
COPY web ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements-lock.txt
COPY pyproject.toml ./
COPY jobs_radar ./jobs_radar
COPY config ./config
COPY contracts ./contracts
COPY deploy ./deploy
COPY --from=website /build/jobs_radar/static ./jobs_radar/static
RUN pip install --no-deps . && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin radar
USER 10001:10001
ENTRYPOINT ["python", "-m", "jobs_radar.cli"]
CMD ["serve"]
