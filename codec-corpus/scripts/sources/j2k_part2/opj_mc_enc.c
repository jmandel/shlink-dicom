/* JPEG 2000 encoder for the Part 2 multi-component corpus cases (codec-corpus/formats/jpeg2000,
 * scripts/sources/j2k_part2.py). Links the system OpenJPEG (libopenjp2); test tooling only.
 *
 * usage: opj_mc_enc IN.i32 W H NCOMP PREC SIGNED OUT.j2k MODE [RATE]
 *   IN.i32  W*H*NCOMP int32 little-endian samples, pixel-interleaved
 *   MODE    "rev"   5/3 wavelet; "irr" 9/7 wavelet. No component transform: the components
 *                   are coded as given (j2k_part2.py adds the Part 2 marker segments).
 *   RATE    compression ratio for one quality layer (0 or absent: all bits)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <openjpeg.h>

int main(int argc, char **argv) {
    if (argc < 9) { fprintf(stderr, "usage: see source\n"); return 2; }
    int w = atoi(argv[2]), h = atoi(argv[3]), nc = atoi(argv[4]), prec = atoi(argv[5]), sg = atoi(argv[6]);
    const char *mode = argv[8];
    float rate = argc > 9 ? (float)atof(argv[9]) : 0.0f;
    if (nc < 1 || nc > 16384 || w < 1 || h < 1) return 2;
    size_t n = (size_t)w * h * nc;
    int32_t *buf = malloc(n * 4);
    FILE *f = fopen(argv[1], "rb");
    if (!f || fread(buf, 4, n, f) != n) { fprintf(stderr, "short input\n"); return 4; }
    fclose(f);
    opj_image_cmptparm_t *cp = calloc((size_t)nc, sizeof *cp);
    for (int c = 0; c < nc; c++) { cp[c].dx = cp[c].dy = 1; cp[c].w = w; cp[c].h = h; cp[c].prec = prec; cp[c].sgnd = sg; }
    opj_image_t *img = opj_image_create(nc, cp, OPJ_CLRSPC_UNSPECIFIED);
    img->x0 = 0; img->y0 = 0; img->x1 = w; img->y1 = h;
    for (size_t i = 0; i < (size_t)w * h; i++)
        for (int c = 0; c < nc; c++) img->comps[c].data[i] = buf[i * nc + c];
    opj_cparameters_t p;
    opj_set_default_encoder_parameters(&p);
    p.tcp_numlayers = 1; p.tcp_rates[0] = rate; p.cp_disto_alloc = 1; p.numresolution = 4;
    p.tcp_mct = 0;
    if (strcmp(mode, "irr") == 0) {
        p.irreversible = 1;
    } else if (strcmp(mode, "rev") != 0) {
        return 2;
    }
    opj_codec_t *cod = opj_create_compress(OPJ_CODEC_J2K);
    if (!opj_setup_encoder(cod, &p, img)) return 5;
    opj_stream_t *s = opj_stream_create_default_file_stream(argv[7], OPJ_FALSE);
    if (!opj_start_compress(cod, img, s) || !opj_encode(cod, s) || !opj_end_compress(cod, s)) return 6;
    opj_stream_destroy(s); opj_destroy_codec(cod); opj_image_destroy(img);
    return 0;
}
