# Apple ID email support for iMessage

Users can message VELNOR through an Apple ID email address when that address is enabled for iMessage and the configured LoopMessage sender receives the inbound conversation.

## Provider requirements

- Configure the LoopMessage inbound webhook to POST to /api/webhooks/imessage.
- The inbound sender identity is taken from LoopMessage's contact field (or supported email aliases when supplied by a provider adapter). Email identities are normalized to lowercase before tenant resolution.
- VELNOR uses the same email contact as the recipient for its reply through the LoopMessage send API.
- LoopMessage documents its contact field as accepting a phone number or iMessage email address. The provider must have an active sender name and the recipient must be reachable through the sender's enabled iMessage channel.

## Tenant isolation

Email-based users are partitioned independently from phone-number users. The normalized sender identity is included in the iMessage tenant key; users do not share conversation history merely because they use the same VELNOR sender name.

## References

- LoopMessage Sending Messages API: https://loopmessage.com/apidocs/send-message/
- LoopMessage phone number vs email sender: https://loopmessage.com/helpdesk/phone-number-vs-email-sender

Email support depends on the LoopMessage account's sender configuration and Apple iMessage reachability; code support alone cannot activate an email address in the provider account.