export default {
  // `--no-warn-ignored` keeps explicitly staged, intentionally ignored files
  // (vendored upstream source under src/agent-host/vendor/) from turning into
  // warnings that fail `--max-warnings=0`.
  "*.{ts,tsx,mjs}": ["eslint --fix --max-warnings=0 --no-warn-ignored", "prettier --write"],
  "*.{css,html,json,md,yaml,yml}": "prettier --write",
};
