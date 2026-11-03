#!/bin/sh
# Aplica o tema/branding de branding/dashboard-scripts.html no InstallationConfig DASHBOARD_SCRIPTS.
cd "$(dirname "$0")/.." || exit 1
B64=$(base64 -w0 branding/dashboard-scripts.html)
# Logo (login, menu e ícone da aba): branding/logo.svg vira data URI nas três configurações de logo
LOGO="data:image/svg+xml;base64,$(base64 -w0 branding/logo.svg)"
scripts/rails_runner.sh "c = InstallationConfig.find_or_initialize_by(name: 'DASHBOARD_SCRIPTS'); c.value = Base64.decode64('$B64').force_encoding('UTF-8'); c.locked = false; c.save!; %w[LOGO LOGO_DARK LOGO_THUMBNAIL].each { |k| l = InstallationConfig.find_or_initialize_by(name: k); l.value = '$LOGO'; l.locked = false; l.save! }; GlobalConfig.clear_cache; puts \"DASHBOARD_SCRIPTS aplicado: #{c.value.bytesize} bytes; logos aplicadas\"" | grep -E "aplicado|Error"
