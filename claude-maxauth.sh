#!/bin/bash
# Force the claude CLI to use the Max/OAuth subscription, not the depleted ANTHROPIC_API_KEY env override.
exec env -u ANTHROPIC_API_KEY DISABLE_AUTOUPDATER=1 claude "$@"
