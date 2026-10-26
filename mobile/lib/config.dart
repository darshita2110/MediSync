import 'package:flutter/foundation.dart';

Uri resolveApiBase(
    {String endpoint = const String.fromEnvironment('API_BASE_URL'),
    bool release = kReleaseMode,
    bool web = kIsWeb,
    TargetPlatform? platform}) {
  final target = platform ?? defaultTargetPlatform;
  final value = endpoint.isNotEmpty
      ? endpoint
      : web || target != TargetPlatform.android
          ? 'http://localhost:3000'
          : 'http://10.0.2.2:3000';
  final uri = Uri.tryParse(value);
  if (uri == null ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      !['http', 'https'].contains(uri.scheme) ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const FormatException(
        'API_BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment');
  }
  if (release && (endpoint.isEmpty || uri.scheme != 'https')) {
    throw const FormatException(
        'Release builds require an explicit HTTPS API_BASE_URL');
  }
  return uri;
}
