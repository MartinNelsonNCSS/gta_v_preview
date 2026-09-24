/**
 * BC7 textures are decoded on the GPU: upload the compressed blocks, draw a
 * full-screen quad into an RGBA framebuffer and read the pixels back. This
 * avoids shipping a (large) software BC7 decoder.
 */

let gl: WebGL2RenderingContext | null | undefined;
let program: WebGLProgram | null = null;

function context(): WebGL2RenderingContext | null {
  if (gl !== undefined) return gl;
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
  if (!gl || !gl.getExtension('EXT_texture_compression_bptc')) {
    gl = null;
    return gl;
  }
  const vs = `#version 300 es
    in vec2 p; out vec2 uv;
    void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const fs = `#version 300 es
    precision highp float; uniform sampler2D t; in vec2 uv; out vec4 c;
    void main() { c = texture(t, uv); }`;
  const compile = (type: number, src: string) => {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    return s;
  };
  program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return gl;
}

/** Returns RGBA pixels, or null when the GPU can't decode BC7. */
export function decodeBc7(data: Uint8Array, width: number, height: number): Uint8Array | null {
  const g = context();
  if (!g || !program) return null;
  const ext = g.getExtension('EXT_texture_compression_bptc')!;
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.compressedTexImage2D(g.TEXTURE_2D, 0, ext.COMPRESSED_RGBA_BPTC_UNORM_EXT, width, height, 0, data);

  const target = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, target);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, width, height, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  const fb = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, target, 0);

  g.viewport(0, 0, width, height);
  g.useProgram(program);
  const loc = g.getAttribLocation(program, 'p');
  g.enableVertexAttribArray(loc);
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, tex);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

  const out = new Uint8Array(width * height * 4);
  g.readPixels(0, 0, width, height, g.RGBA, g.UNSIGNED_BYTE, out);
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.deleteFramebuffer(fb);
  g.deleteTexture(tex);
  g.deleteTexture(target);
  return out;
}
