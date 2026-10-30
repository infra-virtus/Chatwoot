#!/bin/sh
# Aplica o tema/branding de branding/dashboard-scripts.html no InstallationConfig DASHBOARD_SCRIPTS.
cd "$(dirname "$0")/.." || exit 1
B64=$(base64 -w0 branding/dashboard-scripts.html)
scripts/rails_runner.sh "c = InstallationConfig.find_or_initialize_by(name: 'DASHBOARD_SCRIPTS'); c.value = Base64.decode64('$B64').force_encoding('UTF-8'); c.locked = false; c.save!; GlobalConfig.clear_cache; puts \"DASHBOARD_SCRIPTS aplicado: #{c.value.bytesize} bytes\"" | grep -E "aplicado|Error"
