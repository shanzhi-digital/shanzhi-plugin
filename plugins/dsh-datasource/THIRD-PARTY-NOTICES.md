# Third-party notices

This local `dsh-sql` customization is based on [STARDUSTLC666/dsh-sql](https://github.com/STARDUSTLC666/dsh-sql), version 0.5.9, Copyright (c) 2026 stardustlc, MIT licensed. The original copyright and permission notice are preserved in [LICENSE](./LICENSE).

The files under `vendor/` originate from that release. The SQL lexical guards and database read-only transaction behavior are retained. Local changes expose the query validator for the dynamic runtime and replace connection error strings with fixed safe messages. Legacy write-tool definitions remain in the vendored factory for source compatibility but are not registered by this customization.

The new Host integration, data-source management runtime, credential adapter, browser page and tests are local modifications, not an upstream release. `mysql2` and `pg` retain their own package licenses.
