// Test-file maker: RGB 8-bit, optional extra channels, optional photon noise, via libjxl's API.
// enc OUT W H NUM_EC NOISE_ISO DISTANCE MODULAR [CMYK_ICC]
// With CMYK_ICC, extra channel 0 is the black channel and the profile is that CMYK ICC file.
// cmyk.jxl: `enc cmyk.jxl 16 16 1 0 0 0 test-cmyk.icc`, the profile from make-cmyk-profile.c.
#include <jxl/encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  const char *out = argv[1]; int w = atoi(argv[2]), h = atoi(argv[3]), nec = atoi(argv[4]);
  float iso = atof(argv[5]), dist = atof(argv[6]); int modular = atoi(argv[7]);
  JxlEncoder *enc = JxlEncoderCreate(NULL);
  JxlBasicInfo bi; JxlEncoderInitBasicInfo(&bi);
  bi.xsize = w; bi.ysize = h; bi.bits_per_sample = 8; bi.num_color_channels = 3;
  bi.num_extra_channels = nec; bi.uses_original_profile = JXL_TRUE;
  const char *cmyk = argc > 8 ? argv[8] : NULL;
  if (nec > 0 && !cmyk) bi.alpha_bits = 8;
  if (JxlEncoderSetBasicInfo(enc, &bi)) { fprintf(stderr, "basic info\n"); return 1; }
  if (cmyk) {
    FILE *f = fopen(cmyk, "rb"); static unsigned char icc[1 << 20];
    size_t n = fread(icc, 1, sizeof icc, f); fclose(f);
    if (JxlEncoderSetICCProfile(enc, icc, n)) { fprintf(stderr, "icc\n"); return 1; }
  } else {
    JxlColorEncoding ce; JxlColorEncodingSetToSRGB(&ce, JXL_FALSE);
    JxlEncoderSetColorEncoding(enc, &ce);
  }
  for (int i = 0; i < nec; i++) {
    JxlExtraChannelType t = i == 0 ? (cmyk ? JXL_CHANNEL_BLACK : JXL_CHANNEL_ALPHA) : i == 1 ? JXL_CHANNEL_DEPTH : JXL_CHANNEL_OPTIONAL;
    JxlExtraChannelInfo ei; JxlEncoderInitExtraChannelInfo(t, &ei); ei.bits_per_sample = 8;
    if (JxlEncoderSetExtraChannelInfo(enc, i, &ei)) { fprintf(stderr, "ec info %d\n", i); return 1; }
  }
  JxlEncoderFrameSettings *fs = JxlEncoderFrameSettingsCreate(enc, NULL);
  if (dist == 0) JxlEncoderSetFrameLossless(fs, JXL_TRUE); else JxlEncoderSetFrameDistance(fs, dist);
  if (modular) JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_MODULAR, 1);
  if (iso > 0) JxlEncoderFrameSettingsSetFloatOption(fs, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, iso);
  JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EPF, 0);
  JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_GABORISH, 0);
  unsigned char *rgb = malloc(w * h * 3);
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    unsigned char *p = rgb + 3 * (y * w + x);
    p[0] = x * 255 / w; p[1] = y * 255 / h; p[2] = (x * 7 + y * 13) & 255;
  }
  JxlPixelFormat pf = {3, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  if (JxlEncoderAddImageFrame(fs, &pf, rgb, w * h * 3)) { fprintf(stderr, "frame\n"); return 1; }
  JxlPixelFormat pf1 = {1, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  for (int i = 0; i < nec; i++) {
    unsigned char *e = malloc(w * h);
    for (int k = 0; k < w * h; k++) e[k] = (k * (i + 3) + 40 * i) & 255;
    if (JxlEncoderSetExtraChannelBuffer(fs, &pf1, e, w * h, i)) { fprintf(stderr, "ec buf\n"); return 1; }
  }
  JxlEncoderCloseInput(enc);
  size_t cap = 1 << 24, used = 0; unsigned char *buf = malloc(cap);
  unsigned char *next = buf; size_t avail = cap;
  JxlEncoderStatus st = JxlEncoderProcessOutput(enc, &next, &avail);
  if (st != JXL_ENC_SUCCESS) { fprintf(stderr, "process %d\n", st); return 1; }
  used = next - buf;
  FILE *f = fopen(out, "wb"); fwrite(buf, 1, used, f); fclose(f);
  fprintf(stderr, "%s: %zu bytes\n", out, used);
  return 0;
}
