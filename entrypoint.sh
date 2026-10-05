#!/bin/sh
set -e

echo "Running database migrations..."
node /app/dist/src/db/migrate.js

echo "Starting API..."
exec node /app/dist/src/index.js
