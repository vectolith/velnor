# Discord integration

VELNOR accepts Discord application-command interactions at POST /api/webhooks/discord. The first supported command is /ask, with a required string option named prompt. Responses are private (ephemeral).

## Configure

1. Create a Discord application in the Developer Portal.
2. Copy the application's Public Key into DISCORD_PUBLIC_KEY in the VELNOR deployment. This is a verification key, not a bot token.
3. Set the application's Interactions Endpoint URL to https://YOUR-VELNOR-HOST/api/webhooks/discord.
4. Register a global or guild command named ask with one required string option: prompt (type STRING, required).
5. Authorize the application for the servers where people should be able to use the command, with the applications.commands scope.
6. Deploy and verify the endpoint in the Discord Developer Portal.

Example command definition:

    {
      "name": "ask",
      "description": "Ask VELNOR to help with a task",
      "type": 1,
      "options": [{ "name": "prompt", "description": "Your request", "type": 3, "required": true }]
    }

## Security and execution

- Verifies Discord Ed25519 signatures over the exact raw request body and timestamp.
- Rejects requests outside the five-minute timestamp window.
- Discord user ID and guild ID define the tenant partition; callers cannot select another tenant.
- Acknowledges interactions promptly and completes them through Discord's original interaction webhook.
- Replies are private and suppress user mentions.
- No Discord bot token is required for this interactions-only command flow.

This release supports /ask interactions. Scheduled reminders and proactive Discord notifications are not yet supported.