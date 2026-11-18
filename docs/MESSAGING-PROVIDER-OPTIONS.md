# VELNOR iMessage provider: Sendblue

## Selected provider

Sendblue is now the configured outbound iMessage provider for VELNOR. New outbound replies and scheduled iMessage reminders use the Sendblue API through the durable attempt ledger. LoopMessage is no longer used for new outbound sends; its callback parser and stored attempt records remain temporarily for historical reconciliation and migration safety.

The adapter requires:
- Sendblue API key ID and API secret
- An explicit Sendblue sender number (SENDBLUE_FROM_NUMBER or the tenant setting)
- VELNOR_PUBLIC_URL, used to register a per-message delivery-status callback
- SENDBLUE_WEBHOOK_SECRET, configured to match the Sendblue webhook signing secret

Provider acceptance is recorded as queued, not delivered. VELNOR marks an attempt delivered only when an authenticated Sendblue callback reports status=DELIVERED, service=iMessage, and no SMS downgrade. SENT is not treated as iMessage delivery. SMS downgrade is recorded as a failed iMessage attempt and is never presented as iMessage success.

Sendblue supports phone-number iMessage recipients. Its receiving documentation also states that an inbound iMessage may originate from an Apple Account email address and that VELNOR can reply by passing that exact email address as the number recipient. This supports replies to email-originated conversations; it does not establish unrestricted new outbound email initiation.

## $0 plan limitations

Sendblue currently advertises a $0 shared-line sandbox with no credit card, up to 10 verified contacts, and inbound-first messaging. Its documentation says free shared-line recipients must be verified contacts and must text the Sendblue number once before outbound messaging is enabled. The production AI Agent plan is advertised at $100/month per dedicated line; Enterprise pricing is custom.

The public materials reviewed do not guarantee that the sandbox is permanently free, and they do not establish that Apple Account email identities can be added as verified contacts under the free plan. Therefore:
- VELNOR's Sendblue adapter is implemented, but account eligibility and live delivery remain unverified.
- Do not purchase a plan or activate paid credits under the current $0 budget.
- Do not claim the free sandbox meets unrestricted outbound or permanent-free requirements.
- Email-address replies are supported by the documented inbound-thread workflow, but free-plan verification for email identities remains unconfirmed.
- No real messages have been sent as part of this code work.

## Operational and verification requirements

1. Configure Sendblue credentials and sender number only through the deployment's secret/configuration mechanism; never commit secrets or paste them into chat.
2. Configure Sendblue's webhook secret to match SENDBLUE_WEBHOOK_SECRET.
3. Set the account's inbound receive webhook to /api/webhooks/imessage. Each outbound send also supplies that endpoint as status_callback.
4. Verify both phone-originated and Apple Account email-originated inbound conversations before relying on replies.
5. Confirm the callback's message_handle, recipient, sender line, service, status, and was_downgraded fields.
6. Treat mocks and simulated callbacks as code-level evidence only. Real delivery requires a live Sendblue account and verified contacts.
7. Ambiguous transport outcomes are not automatically resent. An explicit retry may create a duplicate if Sendblue accepted the original request before the connection failed.

## Documentation references

- Sendblue pricing and free sandbox: https://www.sendblue.com/api
- Sending messages and free-plan contact verification: https://docs.sendblue.com/getting-started/sending-messages/
- Receiving Apple Account email messages: https://docs.sendblue.com/getting-started/receiving-messages/
- Webhook payloads, delivery statuses, and retry policy: https://docs.sendblue.com/getting-started/webhooks/
- Webhook authentication: https://docs.sendblue.com/security/
