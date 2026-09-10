#!/usr/bin/env python3
"""Read DOCX body text without changing paragraph/table document order."""
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def paragraph_text(paragraph):
    parts = []
    for node in paragraph.iter():
        if node.tag == W + "t":
            parts.append(node.text or "")
        elif node.tag == W + "tab":
            parts.append("\t")
        elif node.tag in (W + "br", W + "cr"):
            parts.append("\n")
    return "".join(parts)


def block_lines(container):
    for child in container:
        if child.tag == W + "p":
            yield paragraph_text(child)
        elif child.tag == W + "tbl":
            for row in child.findall(W + "tr"):
                cells = [" / ".join(block_lines(cell)) for cell in row.findall(W + "tc")]
                yield "\t".join(cells)
        elif child.tag == W + "sdt":
            content = child.find(W + "sdtContent")
            if content is not None:
                yield from block_lines(content)


def main():
    with zipfile.ZipFile(sys.argv[1]) as document:
        root = ET.fromstring(document.read("word/document.xml"))
    body = root.find(W + "body")
    if body is None:
        raise ValueError("DOCX has no document body")
    print("\n".join(block_lines(body)))


if __name__ == "__main__":
    main()
