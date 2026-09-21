#!/usr/bin/env bash
# Redeploy the amplifier workflow, then re-announce the post.
# Run it as ./command.sh — pasting the lines into zsh runs the comments as
# commands, which is where the "command not found: #" lines came from.
set -euo pipefail

WORKFLOW=wfl-daheche743jc73ckf1og

# Build and release main. --wait exits non-zero if the build fails.
render workflows versions release "$WORKFLOW" --commit 8c42a7f --wait --confirm

# Re-post the note, now with Repost and Edit.
render workflows start amplifier/amplifier.announcePost --confirm \
  --input='[{"draftId":"10600920","slackChannel":"amplify-queue","force":true}]'
