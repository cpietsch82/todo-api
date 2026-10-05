#!/bin/sh
set -e

echo "Running database migrations..."
node dist/src/db/migrate.js

echo "Starting API..."
exec node dist/src/index.js
