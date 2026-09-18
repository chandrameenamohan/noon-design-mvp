# Baked variant: node_modules installed at IMAGE BUILD time.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
