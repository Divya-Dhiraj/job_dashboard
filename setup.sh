#!/bin/bash
set -e
export PATH="/opt/homebrew/bin:$PATH"

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║     🎯  Job Dashboard Setup               ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# Check Node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not installed. Please install Node.js v20+ from https://nodejs.org"
  exit 1
fi
NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js v18+ required. You have $(node -v). Please upgrade."
  exit 1
fi
echo "✅ Node.js $(node -v) found."

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed."

# Gmail App Password setup
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📧 Gmail App Password Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  To receive job notification emails, you need a Gmail App Password."
echo "  (This is NOT your regular Gmail password — it's a special 16-char key)"
echo ""
echo "  Steps:"
echo "  1. Open: https://myaccount.google.com/apppasswords"
echo "  2. Sign in to blazeavinash11@gmail.com"
echo "  3. Click 'Create' → name it 'Job Dashboard'"
echo "  4. Copy the 16-character password"
echo ""
read -p "  Paste your Gmail App Password here (or press Enter to skip): " GMAIL_PASS

if [ -n "$GMAIL_PASS" ]; then
  # Update .env file
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/YOUR_16_CHAR_APP_PASSWORD_HERE/$GMAIL_PASS/" .env
  else
    sed -i "s/YOUR_16_CHAR_APP_PASSWORD_HERE/$GMAIL_PASS/" .env
  fi
  echo "  ✅ Gmail App Password saved to .env"
else
  echo "  ⚠️  Skipped. You can add it later to the .env file."
fi

# Resume check
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📄 Resume Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if grep -q "Paste your resume text here" resume.txt 2>/dev/null; then
  echo ""
  echo "  ⚠️  resume.txt still contains placeholder text!"
  echo "  Please copy-paste your resume text into:"
  echo "  $(pwd)/resume.txt"
  echo ""
  echo "  The matching engine needs your resume to score jobs accurately."
else
  echo "  ✅ resume.txt found with content."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🚀 Starting Job Dashboard..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Dashboard will be available at: http://localhost:3000"
echo "  Press Ctrl+C to stop."
echo ""
node server.js
