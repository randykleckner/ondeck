#!/bin/bash

cd ~/Documents/mlb-prospects || exit

echo "Checking for changes..."
git status --short

if [[ -z $(git status --short) ]]; then
  echo "No changes to commit."
  exit 0
fi

git add .
git commit -m "Update OnDeck Prospect"
git push

echo "Done. Cloudflare should redeploy automatically."
