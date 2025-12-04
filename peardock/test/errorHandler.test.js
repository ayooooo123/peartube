import test from 'brittle';
import { AppError, ErrorType, createErrorResponse, sanitizeErrorMessage } from '../utils/errorHandler.js';

test('AppError - creates error with type and code', (t) => {
  const error = new AppError('Test error', ErrorType.VALIDATION, 'TEST_CODE');
  t.equal(error.message, 'Test error');
  t.equal(error.type, ErrorType.VALIDATION);
  t.equal(error.code, 'TEST_CODE');
  t.ok(error.timestamp);
});

test('AppError - toJSON serialization', (t) => {
  const error = new AppError('Test error', ErrorType.NETWORK);
  const json = error.toJSON();
  t.equal(json.error, 'Test error');
  t.equal(json.type, ErrorType.NETWORK);
  t.ok(json.timestamp);
});

test('createErrorResponse - AppError', (t) => {
  const error = new AppError('Test error', ErrorType.VALIDATION, 'TEST_CODE');
  const response = createErrorResponse(error);
  t.equal(response.error, 'Test error');
  t.equal(response.code, 'TEST_CODE');
  t.equal(response.type, ErrorType.VALIDATION);
});

test('createErrorResponse - standard Error', (t) => {
  const error = new Error('Standard error');
  error.code = 'ETIMEDOUT';
  const response = createErrorResponse(error);
  t.equal(response.error, 'Standard error');
  t.equal(response.code, 'ETIMEDOUT');
  t.equal(response.type, ErrorType.NETWORK);
});

test('sanitizeErrorMessage - removes sensitive info', (t) => {
  const message = 'Error accessing /var/run/docker.sock';
  const sanitized = sanitizeErrorMessage(message);
  t.not(sanitized.includes('/var/run/docker.sock'));
  t.ok(sanitized.includes('[REDACTED]'));
});

test('sanitizeErrorMessage - truncates long messages', (t) => {
  const longMessage = 'a'.repeat(300);
  const sanitized = sanitizeErrorMessage(longMessage);
  t.ok(sanitized.length <= 200);
  t.ok(sanitized.endsWith('...'));
});





