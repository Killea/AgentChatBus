import sys
with open('src/mcp_server.py', 'r', encoding='utf-8') as f:
    text = f.read()

import re
text = re.sub(r'name="(thread|msg|agent|bus)\.([a-zA-Z_]+)"', r'name="\1_\2"', text)
text = re.sub(r'name == "(thread|msg|agent|bus)\.([a-zA-Z_]+)"', r'name == "\1_\2"', text)

with open('src/mcp_server.py', 'w', encoding='utf-8') as f:
    f.write(text)
print("Done")
