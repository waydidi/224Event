"""Build small, valid TrueType Inter assets for PDF embedding; retains OFL license.
Requires fonttools (developer tool only). Generated TTFs are committed.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools import subset

for weight in ['Regular', 'Bold']:
    source = TTFont(f'assets/fonts/Inter-{weight}.otf')
    options = subset.Options()
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=list(range(0x250)) + list(range(0x2000,0x2070)) + [0x0e3f,0x20ac,0x2122])
    sub.subset(source)
    builder = FontBuilder(source['head'].unitsPerEm, isTTF=True)
    builder.setupGlyphOrder(source.getGlyphOrder())
    glyphs = source.getGlyphSet()
    outlines = {}
    for name in source.getGlyphOrder():
        pen = TTGlyphPen(glyphs)
        glyphs[name].draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=True))
        outlines[name] = pen.glyph()
    builder.setupGlyf(outlines)
    builder.setupHorizontalMetrics(source['hmtx'].metrics)
    builder.setupHorizontalHeader(ascent=source['hhea'].ascent, descent=source['hhea'].descent)
    builder.setupCharacterMap(source.getBestCmap())
    builder.setupNameTable({'familyName':'Inter Receipt','styleName':weight,'uniqueFontIdentifier':f'InterReceipt-{weight}','fullName':f'Inter Receipt {weight}','psName':f'InterReceipt-{weight}','version':'Version 1.0'})
    os2 = source['OS/2']
    builder.setupOS2(sTypoAscender=os2.sTypoAscender,sTypoDescender=os2.sTypoDescender,usWinAscent=os2.usWinAscent,usWinDescent=os2.usWinDescent,usWeightClass=os2.usWeightClass)
    builder.setupPost()
    builder.setupMaxp()
    builder.save(f'assets/fonts/Inter-Receipt-{weight}.ttf')
