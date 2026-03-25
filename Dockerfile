FROM node:18-alpine

# Instala dependências do Chromium necessárias para Puppeteer/whatsapp-web.js
RUN apk add --no-cache \
	chromium \
	nss \
	freetype \
	harfbuzz \
	ca-certificates \
	ttf-freefont \
	nss \
	alsa-lib \
	at-spi2-atk \
	at-spi2-core \
	cups-libs \
	dbus-libs \
	eudev-libs \
	gtk+3.0 \
	libdrm \
	libxcomposite \
	libxdamage \
	libxrandr \
	mesa-gl \
	pango \
	udev

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3000

# Define o path do Chromium para Puppeteer/whatsapp-web.js
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

CMD ["node", "whatsapp-api.js"]
