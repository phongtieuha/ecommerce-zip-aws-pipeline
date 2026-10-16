# FilePipeline Deployment and Operational Safety Rules

- Use `AWS_PROFILE=filepipeline` and `AWS_REGION=ap-southeast-1` by default unless user explicitly overrides.
- Run an identity pre-check before deployment steps.
- Treat `.env.agent` as the credential source when credential refresh is required.
- If required credential keys are missing or empty in `.env.agent`, stop and ask the user to update `.env.agent` and rerun.
- Never ask the user to paste credential values in chat.
- Keep setup-only flows separate from deploy flows.
- In setup-only flows, do not run deployment.
- Report operational status concisely: success or failure, failing command, AWS error, and next action.
- Redact sensitive values from command output and summaries.
- Distinguish auth failures clearly, including expired token, invalid token, and missing configuration.
- Fail fast on missing prerequisites before long-running deployment actions.
