/**
 * Minimal LZ-UTF8 decompressor.
 *
 * Ported directly from `Decompressor.prototype.decompressBlock` in lzutf8@0.6.x
 * (https://github.com/rotemdan/lzutf8.js), which is the compression library the
 * official xBrowserSync client uses. Only the decompression half is implemented,
 * since this client is read-only, and it runs single-shot over a complete payload
 * rather than as a stream.
 *
 * Format recap: output is a UTF-8 superset. A byte whose top two bits are `11`
 * is either a UTF-8 multi-byte lead byte or the start of a back-reference; the
 * two are told apart by looking at the following byte. If it is a UTF-8
 * continuation byte (`10xxxxxx`) the byte is a literal, otherwise it introduces
 * a match:
 *
 *   byte >>> 5 === 6  (0xC0-0xDF)  ->  1-byte match distance
 *   byte >>> 5 === 7  (0xE0-0xFF)  ->  2-byte match distance, big-endian
 *   match length      = byte & 31
 *
 * Verified byte-for-byte against the real library over 1000+ generated inputs
 * (see tests/lzutf8.test.js).
 *
 * @param {Uint8Array} input compressed bytes
 * @returns {Uint8Array} decompressed UTF-8 bytes
 */
export function decompress(input) {
  // Output grows on demand; matches are resolved against bytes already written,
  // so the whole output must stay addressable (no sliding-window cropping).
  let outputBuffer = new Uint8Array(Math.max(input.length * 4, 1024));
  let outputPosition = 0;

  const outputByte = (value) => {
    if (outputPosition === outputBuffer.length) {
      const grown = new Uint8Array(outputBuffer.length * 2);
      grown.set(outputBuffer);
      outputBuffer = grown;
    }
    outputBuffer[outputPosition++] = value;
  };

  for (let readPosition = 0, inputLength = input.length; readPosition < inputLength; readPosition++) {
    const inputValue = input[readPosition];

    // Top two bits are not `11` -> plain literal byte.
    if (inputValue >>> 6 !== 3) {
      outputByte(inputValue);
      continue;
    }

    const sequenceLengthIdentifier = inputValue >>> 5;

    // A sequence truncated by the end of input. For a complete, valid payload
    // this only happens on malformed data; drop the dangling bytes like the
    // reference implementation does when its stream ends.
    if (
      readPosition === inputLength - 1 ||
      (readPosition === inputLength - 2 && sequenceLengthIdentifier === 7)
    ) {
      break;
    }

    // Followed by a UTF-8 continuation byte -> it is a literal lead byte, not a match.
    if (input[readPosition + 1] >>> 7 === 1) {
      outputByte(inputValue);
      continue;
    }

    const matchLength = inputValue & 31;
    let matchDistance;
    if (sequenceLengthIdentifier === 6) {
      matchDistance = input[readPosition + 1];
      readPosition += 1;
    } else {
      matchDistance = (input[readPosition + 1] << 8) | input[readPosition + 2];
      readPosition += 2;
    }

    // Copied one byte at a time on purpose: overlapping matches (distance <
    // length) are legal and must read bytes as they are produced.
    const matchPosition = outputPosition - matchDistance;
    for (let offset = 0; offset < matchLength; offset++) {
      outputByte(outputBuffer[matchPosition + offset]);
    }
  }

  return outputBuffer.subarray(0, outputPosition);
}

/**
 * Decompress to a string.
 * @param {Uint8Array} input
 * @returns {string}
 */
export function decompressToString(input) {
  return new TextDecoder().decode(decompress(input));
}
