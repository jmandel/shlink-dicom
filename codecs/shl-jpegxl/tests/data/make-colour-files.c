// Lossy (XYB) RGB test files with a chosen enum colour encoding, via libjxl's encoder API.
// enc2 OUT PRIMARIES WHITE TF BITS DISTANCE
//   PRIMARIES srgb|p3|2100|adobe|romm   WHITE d65|dci|e|d50   TF srgb|linear|pq|hlg|709|g22|dci
#include <jxl/encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  const char *out = argv[1], *pr = argv[2], *wp = argv[3], *tf = argv[4];
  int bits = atoi(argv[5]); float dist = atof(argv[6]); int w = 32, h = 24;
  JxlEncoder *enc = JxlEncoderCreate(NULL);
  JxlBasicInfo bi; JxlEncoderInitBasicInfo(&bi);
  bi.xsize = w; bi.ysize = h; bi.bits_per_sample = bits; bi.num_color_channels = 3;
  bi.uses_original_profile = JXL_FALSE;
  if (!strcmp(tf, "pq")) bi.intensity_target = 10000;
  if (JxlEncoderSetBasicInfo(enc, &bi)) return 1;
  JxlColorEncoding ce; memset(&ce, 0, sizeof ce);
  ce.color_space = JXL_COLOR_SPACE_RGB; ce.rendering_intent = JXL_RENDERING_INTENT_RELATIVE;
  if (!strcmp(wp, "d65")) ce.white_point = JXL_WHITE_POINT_D65;
  else if (!strcmp(wp, "dci")) ce.white_point = JXL_WHITE_POINT_DCI;
  else if (!strcmp(wp, "e")) ce.white_point = JXL_WHITE_POINT_E;
  else { ce.white_point = JXL_WHITE_POINT_CUSTOM; ce.white_point_xy[0] = 0.3457; ce.white_point_xy[1] = 0.3585; }
  if (!strcmp(pr, "srgb")) ce.primaries = JXL_PRIMARIES_SRGB;
  else if (!strcmp(pr, "p3")) ce.primaries = JXL_PRIMARIES_P3;
  else if (!strcmp(pr, "2100")) ce.primaries = JXL_PRIMARIES_2100;
  else {
    ce.primaries = JXL_PRIMARIES_CUSTOM;
    double adobe[6] = {0.64, 0.33, 0.21, 0.71, 0.15, 0.06}, romm[6] = {0.7347, 0.2653, 0.1596, 0.8404, 0.0366, 0.0001};
    double *p = !strcmp(pr, "adobe") ? adobe : romm;
    ce.primaries_red_xy[0] = p[0]; ce.primaries_red_xy[1] = p[1];
    ce.primaries_green_xy[0] = p[2]; ce.primaries_green_xy[1] = p[3];
    ce.primaries_blue_xy[0] = p[4]; ce.primaries_blue_xy[1] = p[5];
  }
  if (!strcmp(tf, "srgb")) ce.transfer_function = JXL_TRANSFER_FUNCTION_SRGB;
  else if (!strcmp(tf, "linear")) ce.transfer_function = JXL_TRANSFER_FUNCTION_LINEAR;
  else if (!strcmp(tf, "pq")) ce.transfer_function = JXL_TRANSFER_FUNCTION_PQ;
  else if (!strcmp(tf, "hlg")) ce.transfer_function = JXL_TRANSFER_FUNCTION_HLG;
  else if (!strcmp(tf, "709")) ce.transfer_function = JXL_TRANSFER_FUNCTION_709;
  else if (!strcmp(tf, "dci")) ce.transfer_function = JXL_TRANSFER_FUNCTION_DCI;
  else { ce.transfer_function = JXL_TRANSFER_FUNCTION_GAMMA; ce.gamma = 1 / 2.2; }
  if (JxlEncoderSetColorEncoding(enc, &ce)) { fprintf(stderr, "colour encoding\n"); return 1; }
  JxlEncoderFrameSettings *fs = JxlEncoderFrameSettingsCreate(enc, NULL);
  JxlEncoderSetFrameDistance(fs, dist);
  float *px = malloc(sizeof(float) * w * h * 3);
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    float *p = px + 3 * (y * w + x);
    p[0] = (float)x / (w - 1); p[1] = (float)y / (h - 1); p[2] = 0.5f + 0.5f * ((x * 7 + y * 13) % 32) / 31.0f - 0.25f;
  }
  JxlPixelFormat pf = {3, JXL_TYPE_FLOAT, JXL_NATIVE_ENDIAN, 0};
  if (JxlEncoderAddImageFrame(fs, &pf, px, sizeof(float) * w * h * 3)) { fprintf(stderr, "frame\n"); return 1; }
  JxlEncoderCloseInput(enc);
  size_t cap = 1 << 22; unsigned char *buf = malloc(cap), *next = buf; size_t avail = cap;
  if (JxlEncoderProcessOutput(enc, &next, &avail) != JXL_ENC_SUCCESS) { fprintf(stderr, "process\n"); return 1; }
  FILE *f = fopen(out, "wb"); fwrite(buf, 1, next - buf, f); fclose(f);
  return 0;
}
