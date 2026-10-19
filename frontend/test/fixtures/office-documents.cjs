const { zipSync, strToU8 } = require("fflate");
const ns = {
  word: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  sheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  presentation: "http://schemas.openxmlformats.org/presentationml/2006/main",
  rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  pkg: "http://schemas.openxmlformats.org/package/2006/relationships",
};
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
    "base64",
  ),
);
const relations = (items) =>
  `<Relationships xmlns="${ns.pkg}">${items.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${ns.rel}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/>`).join("")}</Relationships>`;
const theme = `<a:theme xmlns:a="${ns.drawing}"><a:themeElements><a:clrScheme name="Local"><a:accent1><a:srgbClr val="2255AA"/></a:accent1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk1><a:srgbClr val="111111"/></a:dk1></a:clrScheme></a:themeElements></a:theme>`;
const odfNamespaces =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
const odtXml = `<office:document-content ${odfNamespaces}><office:automatic-styles><style:style style:name="Title" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="24pt" fo:font-weight="bold" fo:color="#2255aa"/></style:style><style:style style:name="Em" style:family="text"><style:text-properties fo:font-style="italic" fo:color="#aa2244"/></style:style><style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:background-color="#ddeeff"/></style:style></office:automatic-styles><office:body><office:text><text:h text:outline-level="1" text:style-name="Title">ODT fixture</text:h><text:p>Encrypted local document <text:span text:style-name="Em">with formatting</text:span></text:p><table:table><table:table-row><table:table-cell table:style-name="Cell"><text:p>Styled table</text:p></table:table-cell><table:table-cell><text:p>Local content</text:p></table:table-cell></table:table-row></table:table><text:p><draw:frame svg:width="2cm" svg:height="1cm"><draw:image xlink:href="Pictures/pixel.png"/></draw:frame></text:p></office:text></office:body></office:document-content>`;
const docx = {
  "word/document.xml": `<w:document xmlns:w="${ns.word}" xmlns:a="${ns.drawing}" xmlns:r="${ns.rel}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>DOCX report</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/><w:color w:val="AA2244"/></w:rPr><w:t>Styled text</w:t></w:r><w:r><w:t xml:space="preserve"> and safe &lt;script&gt; text</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:fill="DDEEFF"/><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged table heading</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><a:graphic><a:blip r:embed="image1"/></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`,
  "word/styles.xml": `<w:styles xmlns:w="${ns.word}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="2255AA"/></w:rPr></w:style></w:styles>`,
  "word/_rels/document.xml.rels": relations([
    ["image1", "image", "media/pixel.png"],
    ["external", "image", "https://example.invalid/tracker.png", "External"],
  ]),
  "word/media/pixel.png": png,
};
const xlsx = {
  "xl/workbook.xml": `<workbook xmlns="${ns.sheet}" xmlns:r="${ns.rel}"><sheets><sheet name="Budget" sheetId="1" r:id="s1"/><sheet name="Détails" sheetId="2" r:id="s2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": relations([
    ["s1", "worksheet", "worksheets/sheet1.xml"],
    ["s2", "worksheet", "worksheets/sheet2.xml"],
    ["styles", "styles", "styles.xml"],
    ["strings", "sharedStrings", "sharedStrings.xml"],
  ]),
  "xl/theme/theme1.xml": theme,
  "xl/styles.xml": `<styleSheet xmlns="${ns.sheet}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill></fills><borders count="1"><border><bottom style="thin"><color rgb="FF2255AA"/></bottom></border></borders><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="10" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`,
  "xl/sharedStrings.xml": `<sst xmlns="${ns.sheet}"><si><t>Annual budget</t></si><si><r><rPr><b/><color rgb="FFAA2244"/></rPr><t>Income</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet xmlns="${ns.sheet}"><cols><col min="1" max="1" width="26"/><col min="2" max="2" width="18"/></cols><sheetData><row r="1" ht="32"><c r="A1" s="1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1234.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Progress</t></is></c><c r="B3" s="2"><v>0.375</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Sum</t></is></c><c r="B4"><f>SUM(B2:B3)</f><v>1234.875</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>Date</t></is></c><c r="B5" s="3"><v>45292</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet xmlns="${ns.sheet}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet</t></is></c><c r="B1" t="inlineStr"><is><t>&lt;img src=x onerror=alert(1)&gt;</t></is></c></row></sheetData></worksheet>`,
};
const pptHeader = `xmlns:p="${ns.presentation}" xmlns:a="${ns.drawing}" xmlns:r="${ns.rel}"`;
const pptShape = (text, x, y, color = "2255AA") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Heading"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr b="1" sz="2800"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const pptx = {
  "ppt/presentation.xml": `<p:presentation ${pptHeader}><p:sldIdLst><p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": relations([
    ["s1", "slide", "slides/slide1.xml"],
    ["s2", "slide", "slides/slide2.xml"],
  ]),
  "ppt/theme/theme1.xml": theme,
  "ppt/slides/slide1.xml": `<p:sld ${pptHeader}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F7FAFF"/></a:solidFill></p:bgPr></p:bg><p:spTree>${pptShape("Local presentation", 914400, 457200)}<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1" type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Inherited layout</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:spPr><a:xfrm><a:off x="6858000" y="3657600"/><a:ext cx="914400" cy="457200"/></a:xfrm></p:spPr><p:blipFill><a:blip r:embed="image1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
  "ppt/slides/_rels/slide1.xml.rels": relations([
    ["layout", "slideLayout", "../slideLayouts/slideLayout1.xml"],
    ["image1", "image", "../media/pixel.png"],
  ]),
  "ppt/slideLayouts/slideLayout1.xml": `<p:sldLayout ${pptHeader}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph idx="1" type="body"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="5486400" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`,
  "ppt/slides/slide2.xml": `<p:sld ${pptHeader}><p:cSld><p:spTree>${pptShape("Second slide", 914400, 914400, "AA2244")}</p:spTree></p:cSld></p:sld>`,
  "ppt/media/pixel.png": png,
};
function officePackage(entries, padding = 0) {
  const data = {};
  for (const [name, value] of Object.entries(entries))
    data[name] = typeof value === "string" ? strToU8(value) : value;
  if (padding)
    data["unused/padding.bin"] = [new Uint8Array(padding), { level: 0 }];
  return zipSync(data);
}
module.exports = {
  ns,
  relations,
  png,
  odtXml,
  docx,
  xlsx,
  pptx,
  officePackage,
};
