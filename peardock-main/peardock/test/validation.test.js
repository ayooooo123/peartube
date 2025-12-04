import test from 'brittle';
import * as validation from '../server/utils/validation.js';

test('isValidContainerName - valid names', (t) => {
  t.ok(validation.isValidContainerName('my-container'));
  t.ok(validation.isValidContainerName('container_123'));
  t.ok(validation.isValidContainerName('a'));
  t.ok(validation.isValidContainerName('a'.repeat(63)));
});

test('isValidContainerName - invalid names', (t) => {
  t.not(validation.isValidContainerName(''));
  t.not(validation.isValidContainerName('container with spaces'));
  t.not(validation.isValidContainerName('container@invalid'));
  t.not(validation.isValidContainerName('a'.repeat(64))); // Too long
});

test('isValidImageName - valid images', (t) => {
  t.ok(validation.isValidImageName('nginx:latest'));
  t.ok(validation.isValidImageName('registry.example.com/namespace/image:tag'));
  t.ok(validation.isValidImageName('my-image'));
});

test('isValidImageName - invalid images', (t) => {
  t.not(validation.isValidImageName(''));
  t.not(validation.isValidImageName('image with spaces'));
  t.not(validation.isValidImageName('a'.repeat(256))); // Too long
});

test('isValidPortMapping - valid ports', (t) => {
  t.ok(validation.isValidPortMapping('8080:80/tcp'));
  t.ok(validation.isValidPortMapping('80/tcp'));
  t.ok(validation.isValidPortMapping('8080:80/udp'));
});

test('isValidPortMapping - invalid ports', (t) => {
  t.not(validation.isValidPortMapping(''));
  t.not(validation.isValidPortMapping('invalid'));
  t.not(validation.isValidPortMapping('99999:80/tcp')); // Invalid port
});

test('isValidVolumeMount - valid volumes', (t) => {
  t.ok(validation.isValidVolumeMount('/host:/container'));
  t.ok(validation.isValidVolumeMount('/host:/container:ro'));
});

test('isValidVolumeMount - invalid volumes', (t) => {
  t.not(validation.isValidVolumeMount(''));
  t.not(validation.isValidVolumeMount('no-colon'));
  t.not(validation.isValidVolumeMount('/host/../container')); // Path traversal
});

test('sanitizeEnvVarName - valid names', (t) => {
  t.equal(validation.sanitizeEnvVarName('MY_VAR'), 'MY_VAR');
  t.equal(validation.sanitizeEnvVarName('_PRIVATE'), '_PRIVATE');
  t.equal(validation.sanitizeEnvVarName('var123'), 'var123');
});

test('sanitizeEnvVarName - invalid names', (t) => {
  t.equal(validation.sanitizeEnvVarName('123VAR'), null);
  t.equal(validation.sanitizeEnvVarName('var-with-dash'), null);
  t.equal(validation.sanitizeEnvVarName(''), null);
});

test('validateNumber - valid numbers', (t) => {
  t.equal(validation.validateNumber(5, 0, 10), 5);
  t.equal(validation.validateNumber('5', 0, 10), 5);
  t.equal(validation.validateNumber(0, 0, 10), 0);
});

test('validateNumber - invalid numbers', (t) => {
  t.equal(validation.validateNumber(15, 0, 10), null);
  t.equal(validation.validateNumber('invalid', 0, 10), null);
  t.equal(validation.validateNumber(null, 0, 10), null);
});





