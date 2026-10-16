// Writes a minimal CMYK output profile (made here, with lcms2): a 2-point CLUT from CMYK to
// Lab where lightness falls with ink coverage and the colour stays neutral, and the inverse.
// mkcmyk OUT.icc
#include <lcms2.h>
#include <stdio.h>
int main(int argc, char **argv) {
  cmsHPROFILE h = cmsCreateProfilePlaceholder(NULL);
  cmsSetProfileVersion(h, 2.4);
  cmsSetDeviceClass(h, cmsSigOutputClass);
  cmsSetColorSpace(h, cmsSigCmykData);
  cmsSetPCS(h, cmsSigLabData);
  cmsSetHeaderRenderingIntent(h, INTENT_PERCEPTUAL);
  cmsMLU *desc = cmsMLUalloc(NULL, 1);
  cmsMLUsetASCII(desc, "en", "US", "shlink-dicom test CMYK");
  cmsWriteTag(h, cmsSigProfileDescriptionTag, desc);
  cmsWriteTag(h, cmsSigCopyrightTag, desc);
  cmsWriteTag(h, cmsSigMediaWhitePointTag, cmsD50_XYZ());
  // CMYK -> Lab, 2 grid points per input.
  cmsUInt16Number a2b[16 * 3];
  for (int i = 0; i < 16; i++) {
    int c = (i >> 3) & 1, m = (i >> 2) & 1, y = (i >> 1) & 1, k = i & 1;
    double L = 100.0 * (1 - k) * (1 - (c + m + y) / 4.0);
    a2b[i * 3 + 0] = (cmsUInt16Number)(L / 100.0 * 65535.0);
    a2b[i * 3 + 1] = 0x8080; a2b[i * 3 + 2] = 0x8080;
  }
  cmsPipeline *p = cmsPipelineAlloc(NULL, 4, 3);
  cmsPipelineInsertStage(p, cmsAT_END, cmsStageAllocCLut16bit(NULL, 2, 4, 3, a2b));
  cmsWriteTag(h, cmsSigAToB0Tag, p);
  // Lab -> CMYK: black from lightness only.
  cmsUInt16Number b2a[8 * 4];
  for (int i = 0; i < 8; i++) {
    int l = (i >> 2) & 1;
    b2a[i * 4 + 0] = b2a[i * 4 + 1] = b2a[i * 4 + 2] = 0;
    b2a[i * 4 + 3] = l ? 0 : 65535;
  }
  cmsPipeline *q = cmsPipelineAlloc(NULL, 3, 4);
  cmsPipelineInsertStage(q, cmsAT_END, cmsStageAllocCLut16bit(NULL, 2, 3, 4, b2a));
  cmsWriteTag(h, cmsSigBToA0Tag, q);
  if (!cmsSaveProfileToFile(h, argv[1])) { fprintf(stderr, "save failed\n"); return 1; }
  return 0;
}
