import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api.dart';
import 'models.dart';

abstract interface class SessionStore {
  Future<Session?> read();
  Future<void> save(Session session);
  Future<void> clear();
}

class MemorySessionStore implements SessionStore {
  Session? _value;
  @override
  Future<Session?> read() async => _value;
  @override
  Future<void> save(Session session) async {
    _value = session;
  }

  @override
  Future<void> clear() async {
    _value = null;
  }
}

class SecureSessionStore implements SessionStore {
  static const _key = 'medisync.session.v1';
  final _storage = const FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true));
  @override
  Future<Session?> read() async {
    final value = await _storage.read(key: _key);
    if (value == null) return null;
    try {
      return Session.fromJson(jsonDecode(value) as Json);
    } catch (_) {
      await clear();
      return null;
    }
  }

  @override
  Future<void> save(Session session) =>
      _storage.write(key: _key, value: jsonEncode(session.toJson()));
  @override
  Future<void> clear() => _storage.delete(key: _key);
}

class SessionController extends ChangeNotifier {
  SessionController(this.repository, this.store) {
    repository.api.onUnauthorized = _expire;
  }
  final Repository repository;
  final SessionStore store;
  Session? session;
  bool initialized = false;
  String? message;
  int revision = 0;
  Future<void> _storageTail = Future<void>.value();

  Future<T> _storeOperation<T>(Future<T> Function() operation) {
    final next = _storageTail.then((_) => operation());
    _storageTail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<void> initialize() async {
    try {
      session = await _storeOperation(store.read);
      repository.api.token = session?.token;
    } catch (_) {
      message = 'Your saved session could not be opened. Please sign in again.';
    }
    initialized = true;
    notifyListeners();
  }

  Future<void> authenticate(
      {required String email, required String password, String? name}) async {
    final result = name == null
        ? await repository.login(email, password)
        : await repository.signup(name, email, password);
    try {
      await _storeOperation(() => store.save(result));
    } catch (_) {
      throw const ApiException(
          'Your session could not be stored securely. Please try signing in again.');
    }
    repository.api.token = result.token;
    session = result;
    message = null;
    revision++;
    notifyListeners();
  }

  Future<void> signOut() async {
    try {
      await _storeOperation(store.clear);
    } catch (_) {
      throw const ApiException('Sign-out could not finish. Please try again.');
    }
    _reset();
  }

  void _reset() {
    session = null;
    repository.api.token = null;
    revision++;
    notifyListeners();
  }

  void _expire() {
    message = 'Your session has expired. Please sign in again.';
    _reset();
    unawaited(_storeOperation(store.clear).catchError((Object _) {}));
  }

  @override
  void dispose() {
    repository.api.onUnauthorized = null;
    repository.api.close();
    super.dispose();
  }
}
