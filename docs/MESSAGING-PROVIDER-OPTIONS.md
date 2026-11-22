
## Selected provider


The adapter requires:
- VELNOR_PUBLIC_URL, used to register a per-message delivery-status callback



## $0 plan limitations


The public materials reviewed do not guarantee that the sandbox is permanently free, and they do not establish that Apple Account email identities can be added as verified contacts under the free plan. Therefore:
- Do not purchase a plan or activate paid credits under the current $0 budget.
- Do not claim the free sandbox meets unrestricted outbound or permanent-free requirements.
- Email-address replies are supported by the documented inbound-thread workflow, but free-plan verification for email identities remains unconfirmed.
- No real messages have been sent as part of this code work.

## Operational and verification requirements

3. Set the account's inbound receive webhook to /api/webhooks/imessage. Each outbound send also supplies that endpoint as status_callback.
4. Verify both phone-originated and Apple Account email-originated inbound conversations before relying on replies.
5. Confirm the callback's message_handle, recipient, sender line, service, status, and was_downgraded fields.

## Documentation references

