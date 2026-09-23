# ARGUS on Render (free plan friendly). Node serves the app; a small Python worker runs the NLP module.
FROM node:20-bookworm-slim

# Python for the NLP worker and PDF report; Noto fonts cover Latin and Tamil in the PDF.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-render.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements-render.txt

COPY . .
RUN mkdir -p data/runtime

ENV NODE_ENV=production \
    ARGUS_PYTHON=/opt/venv/bin/python \
    ARGUS_REPORT_FONT=/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf \
    ARGUS_REPORT_FONT_BOLD=/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf \
    ARGUS_REPORT_FONT_TAMIL=/usr/share/fonts/truetype/noto/NotoSansTamil-Regular.ttf \
    PYTHONUNBUFFERED=1

EXPOSE 10000
CMD ["node", "live-server.mjs"]
