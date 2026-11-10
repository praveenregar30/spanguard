#!/bin/sh
cd "$(dirname "$0")"
{ cat 01-head.html 02-core.js 03-overview.js 04-pages.js 05-app.js; printf '</script>\n</body>\n</html>\n'; } > ../index.html
