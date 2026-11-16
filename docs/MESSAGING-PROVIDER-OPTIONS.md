# Messaging provider options under the $0 budget

## Current LoopMessage status

LoopMessage is the provider currently integrated by VELNOR. Its live account, sender identity, real email/phone conversations, callbacks, and retry outcomes have not been verified in this workstream. Do not describe mocked tests as provider delivery evidence. No additional LoopMessage credits or subscription spend is authorized.

## Free self-hosted iMessage candidate: BlueBubbles

[BlueBubbles Server](https://github.com/BlueBubblesApp/bluebubbles-server) is an open-source Apache-2.0 project. It exposes a REST API and webhooks for a Mac running the native Messages app. Its documented webhook events include new messages, message updates (including delivered/read), and message errors. A released server version also added an isDelivered field to message payloads.

### Hard requirements and limits

- It must run on macOS with Messages signed in to an Apple Account; it is not a Linux/Cloudflare Worker replacement. The current server repository states macOS 10.15 Catalina or newer, with newer macOS requirements for some bundled proxy options.
- The Mac must remain powered on and connected for dependable message handling. This is not a hosted, always-available service.
- A recipient must be reachable through iMessage. Phone-number delivery depends on that number being registered and active for iMessage; email-address delivery depends on that Apple ID address being enabled for iMessage.
- BlueBubbles REST API authentication uses a server password/token in the guid query parameter. Any VELNOR adapter must keep it server-side, avoid logging credential-bearing URLs, and expose the Mac endpoint only through a protected HTTPS route.
- Its delivery-update webhook is useful evidence, but VELNOR must validate the actual payload and correlate the event to the exact recipient/message before marking a result delivered.

### Decision

BlueBubbles is the strongest $0 software alternative found, provided an already-owned, always-on compatible Mac is available. It avoids a paid messaging vendor but does not remove the hardware, electricity, internet, Apple Account, and operational requirements. No Mac availability is assumed, and no BlueBubbles adapter or live delivery has been implemented or claimed yet.

If no suitable Mac is already available, there is no verified zero-cost hosted replacement in this assessment that can be relied on for production iMessage delivery. Keep the provider boundary and mocked contract tests, and do not silently substitute SMS, email, or a paid trial for iMessage.

## Evidence references

- BlueBubbles Server source and macOS requirements: https://github.com/BlueBubblesApp/bluebubbles-server
- BlueBubbles REST API and webhook documentation: https://github.com/BlueBubblesApp/bluebubbles-docs/blob/master/server/developer-guides/rest-api-and-webhooks.md
- BlueBubbles release notes (message delivery payload field and webhook support): https://github.com/BlueBubblesApp/bluebubbles-server/releases