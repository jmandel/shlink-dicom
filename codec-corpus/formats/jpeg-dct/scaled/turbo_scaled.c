/* Test oracle for shl-codec-jpeg's decode_frame_scaled: libjpeg-turbo's own scaled decode.
 * Not part of the decoder. Build: cc -O2 -o turbo_scaled turbo_scaled.c -ljpeg (libjpeg-turbo >= 3.0)
 * Usage: turbo_scaled IN.jpg DENOM YCC OUT.raw
 *   DENOM 1, 2, 4 or 8; YCC 1 or 0 decides YCbCr or RGB for 3-component frames without a JFIF or
 *   Adobe marker (the DICOM photometric decides there in shl-codec-jpeg; libjpeg would guess from
 *   component ids). Default settings otherwise: JDCT_ISLOW, fancy upsampling.
 * Writes interleaved samples (u8, or u16 little-endian for 12-bit) and prints "WIDTH HEIGHT COMPS".
 */
#include <stdio.h>
#include <stdlib.h>
#include <jpeglib.h>

int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage\n"); return 1; }
  FILE *in = fopen(argv[1], "rb");
  if (!in) { perror(argv[1]); return 1; }
  struct jpeg_decompress_struct cinfo;
  struct jpeg_error_mgr jerr;
  cinfo.err = jpeg_std_error(&jerr);
  jpeg_create_decompress(&cinfo);
  jpeg_stdio_src(&cinfo, in);
  jpeg_read_header(&cinfo, TRUE);
  if (cinfo.num_components == 3 && !cinfo.saw_JFIF_marker && !cinfo.saw_Adobe_marker)
    cinfo.jpeg_color_space = atoi(argv[3]) ? JCS_YCbCr : JCS_RGB;
  if (cinfo.num_components == 3) cinfo.out_color_space = JCS_RGB;
  cinfo.scale_num = 1;
  cinfo.scale_denom = atoi(argv[2]);
  jpeg_start_decompress(&cinfo);
  int w = cinfo.output_width, h = cinfo.output_height, n = cinfo.output_components;
  FILE *out = fopen(argv[4], "wb");
  if (cinfo.data_precision == 12) {
    J12SAMPROW row = malloc(sizeof(J12SAMPLE) * w * n);
    unsigned short *buf = malloc(2 * w * n);
    while (cinfo.output_scanline < cinfo.output_height) {
      jpeg12_read_scanlines(&cinfo, &row, 1);
      for (int i = 0; i < w * n; i++) buf[i] = (unsigned short)row[i];
      fwrite(buf, 2, w * n, out);
    }
  } else {
    JSAMPROW row = malloc(w * n);
    while (cinfo.output_scanline < cinfo.output_height) {
      jpeg_read_scanlines(&cinfo, &row, 1);
      fwrite(row, 1, w * n, out);
    }
  }
  fclose(out);
  printf("%d %d %d\n", w, h, n);
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  return 0;
}
