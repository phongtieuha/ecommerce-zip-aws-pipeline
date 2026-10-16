# FilePipeline AWS Lambda and Security Rules

- Use `ap-southeast-1` only for AWS resources and commands.
- Never hardcode ARNs, account IDs, secrets, access keys, session tokens, or environment-specific endpoints.
- Read environment-specific values from environment variables or config files.
- Validate and sanitize all external inputs, including S3 keys, queue payloads, mapping values, and zip entry paths.
- Prefer least-privilege patterns when adding IAM-related behavior.
- Keep code changes minimal, focused, and compatible with existing interfaces unless explicitly asked to change them.
- Add concise operational logging for failures, but never log secret values.
- Return actionable errors with enough context to debug safely.
- After edits, run relevant package-level verification commands when possible and report what was or was not verified.
