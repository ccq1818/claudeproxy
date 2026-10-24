#!/bin/sh
# one-shot bootstrap: install the mac public key for key-based SSH
mkdir -p /root/.ssh && chmod 700 /root/.ssh
curl -fsSL https://raw.githubusercontent.com/ccq1818/claudeproxy/master/keys/mac.pub >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo BOOTSTRAP_DONE
