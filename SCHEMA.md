# Export JSON Schema

The exporter produces a ZIP containing one JSON file per chat plus a `_manifest.json`.

## `_manifest.json`

```jsonc
{
  "exporter": "WhatsApp Web JSON Exporter",
  "version": "0.1.0",
  "exportedAt": "2026-10-03T12:00:00.000Z",  // ISO-8601, when the export ran
  "storeSource": "named",                     // "named" | "moduleRaid" | "dom"
  "account": "11111@c.us",                    // your own WID, or null if unavailable
  "chatCount": 42,                            // chats discovered
  "exportedChatCount": 42,                    // chats actually written (failures skipped)
  "cancelled": false,                         // true if the user cancelled mid-run
  "files": {
    "11111@c.us": {
      "filename": "2026-09-30_Alice-Smith.json",
      "name": "Alice Smith",
      "messageCount": 1423,
      "lastMessageTimestamp": 1727900000
    }
    // ... one entry per exported chat, keyed by chat id
  }
}
```

## Per-chat file

Filename: `<YYYY-MM-DD of last message>_<sanitized chat name>.json`. Collisions get a short id suffix.

```jsonc
{
  "id": "11111@c.us",            // chat WID (JID). Groups end in @g.us, 1:1 in @c.us
  "name": "Alice Smith",         // display name / group subject
  "isGroup": false,
  "archived": false,
  "pinned": false,
  "unreadCount": 0,
  "participants": [              // groups only; empty array for 1:1
    { "id": "33333@c.us", "isAdmin": true, "isSuperAdmin": false }
  ],
  "lastMessageTimestamp": 1727900000,  // unix seconds of newest message (null if empty)
  "messageCount": 1423,
  "messages": [ /* Message[], ordered oldest → newest */ ]
}
```

## Message

```jsonc
{
  "id": "false_11111@c.us_3EB0ABCDEF",   // serialized MsgKey; null if unresolved
  "timestamp": 1727900000,                // unix seconds; null if unknown
  "isoTime": "2024-10-02T22:00:00.000Z",  // ISO-8601 of timestamp; null if unknown
  "from": "11111@c.us",                   // sender WID
  "to": "22222@c.us",                     // recipient WID (often your/the chat WID)
  "author": null,                         // group member who sent it; null in 1:1
  "fromMe": false,                        // true if you sent it
  "type": "chat",                         // see Types below
  "subtype": null,                        // present for some system/group messages
  "body": "Hello",                        // text content; null for pure-media/system
  "caption": null,                        // media caption, if any
  "quotedMsgId": null,                    // id of the quoted/replied message, if any
  "mentionedIds": [],                     // WIDs @-mentioned
  "ack": 3,                               // delivery/read ack level (see below); null if n/a
  "star": false,

  // present only for media types; NEVER contains file bytes
  "media": {
    "mimetype": "image/jpeg",
    "filename": "IMG-20240101-WA0001.jpg",
    "size": 183221,                       // bytes, if known
    "mediaKeyPresent": true,              // whether an (undecrypted) media key exists
    "isViewOnce": false,
    "duration": null,                     // seconds, for audio/video/ptt
    "location": null                      // { lat, lng, name } for type "location"
  }
}
```

### Types

Common `type` values (WhatsApp may emit others):

| type        | meaning                                   |
|-------------|-------------------------------------------|
| `chat`      | plain text message                        |
| `image`     | photo (media metadata)                    |
| `video`     | video (media metadata)                    |
| `ptt`       | voice note / push-to-talk                 |
| `audio`     | audio file                                |
| `document`  | file attachment                           |
| `sticker`   | sticker                                   |
| `location`  | shared location (`media.location`)        |
| `vcard`     | shared contact card                       |
| `revoked`   | message deleted for everyone              |
| `gp2`       | group system event (add/remove/subject…)  |

### Ack levels

`ack` roughly maps to: `-1` error, `0` pending, `1` sent (✓), `2` delivered (✓✓), `3` read (blue ✓✓), `4` played (voice/video).

## Notes & limitations

- **No media bytes.** Only metadata is exported. Decrypting/downloading media is out of scope.
- **"Full history" means what WhatsApp can page in.** The script repeatedly asks WhatsApp to load earlier messages until it reports no more; very old messages that WhatsApp itself won't serve to the web client are not recoverable.
- Fields can be `null` when WhatsApp's model doesn't expose them for a given message/build.
