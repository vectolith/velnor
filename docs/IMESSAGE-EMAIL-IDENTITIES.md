# Apple ID email support for iMessage

Users can message VELNOR through an Apple ID email address when that address is enabled for iMessage and the configured LoopMessage sender receives the inbound conversation.

## Use an email sender for VELNOR (no dedicated phone number)

In the LoopMessage dashboard, create or activate an **email sender name** for VELNOR. VELNOR does not need to purchase or maintain a dedicated phone number for this iMessage path. Set `LOOPMESSAGE_SENDER_ID` to that sender's LoopMessage ID in the deployment environment. This is the sender ID, not the email address. The outbound adapter includes this ID on replies so LoopMessage uses the selected email sender instead of choosing another sender from the account. VELNOR fails closed if this ID is missing; it never relies on LoopMessage selecting a default sender.

Email-only senders have provider-side warm-up and deliverability limitations. Users should initiate the iMessage conversation with VELNOR's email sender first; do not depend on VELNOR initiating cold conversations to new contacts.

## Provider requirements

- Configure the LoopMessage inbound webhook to POST to /api/webhooks/imessage.
- The inbound sender identity is taken from LoopMessage's contact field (or supported email aliases when supplied by a provider adapter). Email identities are normalized to lowercase before tenant resolution.
- VELNOR uses the exact normalized inbound `contact` value as the outbound `contact`, whether it is an E.164 phone number or Apple ID email.
- Every outbound message includes the configured `LOOPMESSAGE_SENDER_ID`. This is the LoopMessage sender-name ID for VELNOR's email-based iMessage identity.
- A successful send API response is only `queued`, not delivered. VELNOR stores the LoopMessage message ID, tenant, task ID, exact recipient, and sender ID. `message_delivered` and `message_failed` callbacks update the durable delivery record only when message ID, recipient, and sender all match.
- Task retries reuse the original persisted `userHandle`; delivery retries are tenant-scoped and refuse to resend a result already marked delivered.
- LoopMessage documents its contact field as accepting a phone number or iMessage email address. The provider must have an active sender name and the recipient must be reachable through the sender's enabled iMessage channel.

## Delivery verification

LoopMessage documents `message_delivered` and `message_failed` callbacks and a message-status endpoint. A queued API response must never be presented as delivered. The integration acceptance suite must verify both phone and email contacts, sender selection, recovery/retry identity preservation, and mismatched callback rejection. Live delivery confirmation still requires an actual configured LoopMessage account and reachable test phone/email identities.

## Tenant isolation

Email-based users are partitioned independently from phone-number users. The normalized sender identity is included in the iMessage tenant key; users do not share conversation history merely because they use the same VELNOR sender name.

## References

- LoopMessage Sending Messages API: https://loopmessage.com/apidocs/send-message/
- LoopMessage phone number vs email sender: https://loopmessage.com/helpdesk/phone-number-vs-email-sender

Email support depends on the LoopMessage account's sender configuration and Apple iMessage reachability; code support alone cannot activate an email address in the provider account.