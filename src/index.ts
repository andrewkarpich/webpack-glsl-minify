// src/index.ts
// Copyright 2018 Leo C. Singleton IV <leo@leosingleton.com>

import { loader } from 'webpack';
import LoaderContext = loader.LoaderContext;

import { readFile } from 'fs';
import { dirname } from 'path';

export interface GlslUniform {
  /** Variable type, e.g. 'vec3' or 'float' */
  type: string;

  /** Minified variable name */
  min: string;
}

/** Map of original unminified names to their minified details */
type UniformMap = { [original: string]: GlslUniform };

/** Output of the GLSL Minifier */
export interface GlslProgram {
  /** Minified GLSL code */
  code: string;

  /** Uniform variable names. Maps the original unminified name to its minified details. */
  map: UniformMap;
}

export interface GlslFile {
  /** Full path of the file (for resolving further @include directives) */
  path?: string;

  /** Unparsed file contents */
  contents: string;
}

/**
 * List of GLSL reserved keywords to avoid mangling. We automatically include any gl_ variables.
 */
let glslReservedKeywords = [
  // Basic types
  'bool', 'double', 'float', 'int', 'uint',

  // Vector types
  'vec2', 'vec3', 'vec4',
  'bvec2', 'bvec3', 'bvec4',
  'dvec2', 'dvec3', 'dvec4',
  'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4',

  // Matrix types
  'mat2', 'mat2x2', 'mat2x3', 'mat2x4',
  'mat3', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4', 'mat4x2', 'mat4x3', 'mat4x4',

  // Other type-related keywords
  'attribute', 'const', 'false', 'invariant', 'struct', 'true', 'uniform', 'varying', 'void',

  // Precision keywords
  'highp', 'lowp', 'mediump', 'precision',

  // Input/output keywords
  'in', 'inout', 'out',

  // Control keywords
  'break', 'continue', 'do', 'else', 'for', 'if', 'main', 'return', 'while',

  // Built-in macros
  '__FILE__', '__LINE__', '__VERSION__', 'GL_ES', 'GL_FRAGMENT_PRECISION_HIGH',

  // Trig functions
  'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'cos', 'cosh', 'degrees', 'radians', 'sin', 'sinh', 'tan', 'tanh',

  // Exponents and logarithms
  'exp', 'exp2', 'inversesqrt', 'log', 'log2', 'pow', 'sqrt',

  // Clamping and modulus-related funcions
  'abs', 'ceil', 'clamp', 'floor', 'fract', 'max', 'min', 'mod', 'modf', 'round', 'roundEven', 'sign', 'trunc',

  // Floating point functions
  'isinf', 'isnan',

  // Boolean functions
  'all', 'any', 'equal','greaterThan', 'greaterThanEqual', 'lessThan', 'lessThanEqual', 'not', 'notEqual',

  // Vector functions
  'cross', 'distance', 'dot', 'faceforward', 'length', 'outerProduct', 'normalize', 'reflect', 'refract',

  // Matrix functions
  'determinant', 'inverse', 'matrixCompMult',
  
  // Interpolation functions
  'mix', 'step', 'smoothstep',

  // Texture functions
  'texture2D', 'texture2DProj', 'textureCube', 'textureSize',

  // Noise functions
  'noise1', 'noise2', 'noise3', 'noise4',

  // Derivative functions
  'dFdx', 'dFdxCoarse', 'dFdxFine',
  'dFdy', 'dFdyCoarse', 'dFdyFine',
  'fwidth', 'fwidthCoarse', 'fwidthFine'
];

/**
 * Helper class to minify tokens and track reserved ones
 */
export class TokenMap {
  constructor() {
    // GLSL has many reserved keywords. In order to not minify them, we add them to the token map now.
    this.reserveKeywords(glslReservedKeywords);
  }

  /**
   * The underlying token map itself. Although the data type is GlslUniform, it is used for all tokens, not just
   * uniforms. The type property of GlslUniform is only set for uniforms, however.
   */
  private tokens: UniformMap = {};

  /**
   * Adds keywords to the reserved list to prevent minifying them.
   * @param keywords 
   */
  public reserveKeywords(keywords: string[]): void {
    for (let n = 0; n < keywords.length; n++) {
      let keyword = keywords[n];
      this.tokens[keyword] = { type: undefined, min: keyword };
    }
  }

  /**
   * Number of tokens minified. Used to generate unique names. Although we could be more sophisticated, and count
   * usage, we simply assign names in order. Few shaders have more than 52 variables (the number of single-letter
   * variable names), so simple is good enough.
   */
  private minifiedTokenCount = 0;

  /**
   * Converts a token number to a name
   */
  public static getMinifiedName(tokenCount: number): string {
    let num = tokenCount % 52;
    let offset = (num < 26) ? (num + 65) : (num + 71); // 65 = 'A'; 71 = ('a' - 26)
    let c = String.fromCharCode(offset);

    // For tokens over 52, recursively add characters
    let recurse = Math.floor(tokenCount / 52);
    return (recurse === 0) ? c : (this.getMinifiedName(recurse - 1) + c);
  }

  /**
   * Minifies a token
   * @param name Token name
   * @param uniformType If the token is a uniform, the data type
   * @returns Minified token name
   */
  public minifyToken(name: string, uniformType?: string): string {
    // Special-case any tokens starting with "gl_". They should never be minified.
    if (name.startsWith('gl_')) {
      return name;
    }

    // Check whether the token already has an existing minified value
    let existing = this.tokens[name];
    if (existing) {
      return existing.min;
    }

    // Allocate a new value
    let min = TokenMap.getMinifiedName(this.minifiedTokenCount++);
    this.tokens[name] = {
      min: min,
      type: uniformType
    };

    return min;
  }

  /**
   * Returns the uniforms and their associated data types
   */
  public getUniforms(): UniformMap {
    // Filter only the tokens that have the type field set
    let result: UniformMap = {};
    for (let original in this.tokens) {
      let token = this.tokens[original];
      if (token.type) {
        result[original] = token;
      }
    }

    return result;
  }
}

export enum TokenType {
  /**
   * Normal token. May be a variable, function, or reserved keyword. (Note: attribute, uniform, and varying are
   * handled specially below)
   */
  ttToken,

  /** The attribute keyword */
  ttAttribute,

  /** The uniform keyword */
  ttUniform,

  /** The varying keyword */
  ttVarying,

  /** An operator, including brackets and parentheses. (Note: dot is a special one below) */
  ttOperator,

  /** The dot operator. This operator has special meaning in GLSL due to vector swizzle masks. */
  ttDot,

  /** A numeric value */
  ttNumeric,

  /** A GLGL preprocessor directive */
  ttPreprocessor,

  /** Special value used in the parser when there is no token */
  ttNone
}

export class GlslMinify {
  constructor(loader: LoaderContext) {
    this.loader = loader;
  }

  /** List of tokens minified by the parser */
  private tokens = new TokenMap();

  public async execute(content: string): Promise<GlslProgram> {
    let input: GlslFile = { contents: content };

    // Perform the minification. This takes three separate passes over the input.
    let pass1 = await this.preprocessPass1(input);
    let pass2 = this.preprocessPass2(pass1);
    let pass3 = this.minifier(pass2);

    return {
      code: pass3,
      map: this.tokens.getUniforms()
    };
  }

  public readFile(filename: string, directory?: string): Promise<GlslFile> {
    return new Promise<GlslFile>((resolve, reject) => {
      // If no directory was provided, use the root GLSL file being included
      if (!directory && this.loader) {
        directory = this.loader.context;
      }

      let readInternal = (path: string) => {
        readFile(path, 'utf-8', (err, data) => {
          if (!err) {
            // Success
            resolve({ path: path, contents: data });
          } else {
            reject(err);
          }
        });
      };

      if (this.loader) {
        // Resolve the file path
        this.loader.resolve(directory, filename, (err: Error, path: string) => {
          if (err) {
            return reject(err);
          }

          this.loader.addDependency(path);
          readInternal(path);
        });
      } else {
        // Special case for unit tests without a Webpack LoaderContext. Just read the file.
        readInternal(filename);
      }
    });
  }

  /**
   * The first pass of the preprocessor removes comments and handles include directives
   */
  public async preprocessPass1(content: GlslFile): Promise<string> {
    let output = content.contents;

    // Remove carriage returns. Use newlines only.
    output = output.replace('\r', '');

    // Remove C style comments
    let cStyleRegex = /\/\*[\s\S]*?\*\//g;
    output = output.replace(cStyleRegex, '');

    // Remove C++ style comments
    let cppStyleRegex = /\/\/[^\n]*/g;
    output = output.replace(cppStyleRegex, '\n');

    // Process @include directive
    let includeRegex = /@include\s(.*)/;
    while (true) {
      // Find the next @include directive
      let match = includeRegex.exec(output);
      if (!match) {
        break;
      }
      let includeFilename = JSON.parse(match[1]);

      // Read the file to include
      let currentPath = content.path ? dirname(content.path) : undefined;
      let includeFile = await this.readFile(includeFilename, currentPath);

      // Parse recursively, as the included file may also have @include directives
      let includeContent = await this.preprocessPass1(includeFile);

      // Replace the @include directive with the file contents
      output = output.replace(includeRegex, includeContent);
    }

    return output;
  }

  /**
   * The second pass of the preprocessor handles nomange and define directives
   */
  public preprocessPass2(content: string): string {
    let output = content;

    // Process @nomangle directives
    let nomangleRegex = /@nomangle\s(.*)/;
    while (true) {
      // Find the next @nomangle directive
      let match = nomangleRegex.exec(output);
      if (!match) {
        break;
      }

      // Record the keywords
      let keywords = match[1].split(/\s/);
      this.tokens.reserveKeywords(keywords);

      // Remove the @nomangle line
      output = output.replace(nomangleRegex, '');
    }

    // Process @define directives
    let defineRegex = /@define\s(\S+)\s(.*)/;
    while (true) {
      // Find the next @define directive
      let match = defineRegex.exec(output);
      if (!match) {
        break;
      }
      let defineMacro = match[1];
      let replaceValue = match[2];

      // Remove the @define line
      output = output.replace(defineRegex, '');

      // Replace all instances of the macro with its value
      //
      // BUGBUG: We start at the beginning of the file, which means we could do replacements prior to the @define
      //   directive. This is unlikely to happen in real code but will cause some weird behaviors if it does.
      let offset = output.indexOf(defineMacro);
      while (offset >= 0 && offset < output.length) {
        // Ensure that the macro isn't appearing within a larger token
        let nextOffset = offset + defineMacro.length;
        let nextChar = output[nextOffset];
        if (/\w/.test(nextChar)) {
          // Ignore. Part of a larger token. Begin searching again at the next non-word.
          do {
            nextChar = output[++nextOffset];
          } while (nextChar && /\w/.test(nextChar));
          offset = nextOffset;
        } else {
          // Replace
          let begin = output.substring(0, offset);
          let end = output.substring(nextOffset);
          output = begin + replaceValue + end;
          offset += replaceValue.length;
        }

        // Advance the offset
        offset = output.indexOf(defineMacro, offset);
      }
    } 

    return output;
  }

  /** Determines the token type of a token string */
  public static getTokenType(token: string): TokenType {
    if (token === 'attribute') {
      return TokenType.ttAttribute;
    } else if (token === 'uniform') {
      return TokenType.ttUniform;
    } else if (token === 'varying') {
      return TokenType.ttVarying;
    } else if (token === '.') {
      return TokenType.ttDot;
    } else if (token[0] === '#') {
      return TokenType.ttPreprocessor;
    } else if (/[0-9]/.test(token[0])) {
      return TokenType.ttNumeric;
    } else if (/\w/.test(token[0])) {
      return TokenType.ttToken;
    } else {
      return TokenType.ttOperator;
    }
  }

  /**
   * The final pass consists of the actual minifier itself
   */
  public minifier(content: string): string {
    // Unlike the previous passes, on this one, we start with an empty output and build it up
    let output = '';

    // The token regex looks for any of three items:
    //  1) An alphanumeric token (\w+), which may include underscores
    //  2) One or more operators (non-alphanumeric)
    //  3) GLSL preprocessor directive beginning with #
    let tokenRegex = /\w+|[^\s\w#.]+|\.|#.*/g;

    // Minifying requires a simple state machine the lookbacks to the previous two tokens
    let match: string[]
    let prevToken: string;
    let prevType = TokenType.ttNone;
    let prevPrevType = TokenType.ttNone;
    while (match = tokenRegex.exec(content)) {
      let token = match[0];
      let type = GlslMinify.getTokenType(token);

      switch (type) {
        case TokenType.ttPreprocessor:
          // Special case for #define: we want to minify the value being defined
          let defineRegex = /#define\s(\w+)\s(.*)/;
          let subMatch = defineRegex.exec(token);
          if (subMatch) {
            let minToken = this.tokens.minifyToken(subMatch[1]);
            output += '#define ' + minToken + ' ' + subMatch[2] + '\n';
            break;
          }

          // Preprocessor directives are special in that they require the newline
          output += token + '\n';
          break;

        case TokenType.ttOperator:
        case TokenType.ttDot:
        case TokenType.ttNumeric:
          output += token;
          break;

        case TokenType.ttToken:
        case TokenType.ttAttribute:
        case TokenType.ttUniform:
        case TokenType.ttVarying:
          // Special case: a token following a dot is a swizzle mask. Leave it as-is.
          if (prevType === TokenType.ttDot) {
            output += token;
            break;
          }

          // For attribute and varying declarations, turn off minification.
          if (prevPrevType === TokenType.ttAttribute || prevPrevType === TokenType.ttVarying) {
            this.tokens.reserveKeywords([token]);
          }

          // Try to minify the token
          let minToken: string;
          if (prevPrevType === TokenType.ttUniform) {
            // This is a special case of a uniform declaration
            minToken = this.tokens.minifyToken(token, prevToken);
          } else {
            // Normal token
            minToken = this.tokens.minifyToken(token);
          }

          // When outputting, if the previous token was not an operator or newline, leave a space.
          if (prevType !== TokenType.ttOperator && prevType !== TokenType.ttPreprocessor) {
            output += ' ';
          }
          output += minToken;
          break;
      }

      // Advance to the next token
      prevPrevType = prevType;
      prevType = type;
      prevToken = token;
    }

    return output;
  }

  private loader: LoaderContext;
}

export default async function(content: string) {
  let loader = this as LoaderContext;
  loader.async();

  try {
    let glsl = new GlslMinify(loader);
    let program = await glsl.execute(content);

    loader.callback(null, 'module.exports = ' + JSON.stringify(program));
  } catch (err) {
    loader.emitError(err);
  }
};
