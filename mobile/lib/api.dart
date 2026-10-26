import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

class ApiException implements Exception {
  const ApiException(this.message, {this.status, this.data = const {}});
  final String message;
  final int? status;
  final Json data;
  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(
      {required Uri baseUrl,
      http.Client? transport,
      this.timeout = const Duration(seconds: 20)})
      : baseUrl = Uri.parse(
            '${baseUrl.toString().replaceFirst(RegExp(r'/+$'), '')}/'),
        _transport = transport ?? http.Client();
  final Uri baseUrl;
  final http.Client _transport;
  final Duration timeout;
  String? token;
  void Function()? onUnauthorized;

  Future<Json> request(String method, String path,
      {Json? body,
      Map<String, String>? query,
      bool authenticated = true}) async {
    final requestToken = authenticated ? token : null;
    final uri = baseUrl.resolve('api/$path').replace(queryParameters: query);
    final req = http.Request(method, uri)
      ..headers['Accept'] = 'application/json';
    if (requestToken != null) {
      req.headers['Authorization'] = 'Bearer $requestToken';
    }
    if (body != null) {
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    http.Response response;
    try {
      response = await (() async =>
              http.Response.fromStream(await _transport.send(req)))()
          .timeout(timeout);
    } on TimeoutException {
      throw const ApiException(
          'The connection timed out. Refresh before retrying a change.');
    } on http.ClientException {
      throw const ApiException(
          'We could not connect. Check your connection and try again.');
    }
    Json data;
    try {
      data = jsonDecode(utf8.decode(response.bodyBytes)) as Json;
    } on FormatException {
      throw const ApiException(
          'The service returned an unexpected response. Please try again.');
    } on TypeError {
      throw const ApiException(
          'The service returned an unexpected response. Please try again.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      // A late response from a previous session must not sign out a new user.
      if (response.statusCode == 401 &&
          authenticated &&
          requestToken == token) {
        onUnauthorized?.call();
      }
      throw ApiException(
          data['error'] as String? ?? 'This action could not be completed.',
          status: response.statusCode,
          data: data);
    }
    return data;
  }

  void close() => _transport.close();
}

class Repository {
  Repository(this.api);
  final ApiClient api;
  Future<Session> login(String email, String password) async =>
      Session.fromJson(await api.request('POST', 'auth/login',
          body: {'email': email, 'password': password}, authenticated: false));
  Future<Session> signup(String name, String email, String password) async =>
      Session.fromJson(await api.request('POST', 'auth/signup',
          body: {'name': name, 'email': email, 'password': password},
          authenticated: false));
  Future<List<Patient>> patients() async => decodeList(
      (await api.request('GET', 'patients'))['patients'], Patient.fromJson);
  Future<Patient> createPatient(Json body) async {
    final result =
        (await api.request('POST', 'patients', body: body))['patient'] as Json;
    return Patient.fromJson({...result, 'role': 'owner'});
  }

  Future<List<Invite>> invites() async => decodeList(
      (await api.request('GET', 'invites'))['invites'], Invite.fromJson);
  Future<void> acceptInvite(String id) async {
    await api.request('POST', 'invites/$id/accept', body: {});
  }

  Future<List<Doctor>> doctors(String p) async => decodeList(
      (await api.request('GET', 'patients/$p/prescribers'))['prescribers'],
      Doctor.fromJson);
  Future<void> addDoctor(String p, Json body) async {
    await api.request('POST', 'patients/$p/prescribers', body: body);
  }

  Future<List<Medicine>> medicines(String p) async => decodeList(
      (await api.request('GET', 'patients/$p/items'))['items'],
      Medicine.fromJson);
  Future<List<Prescription>> prescriptions(String p) async => decodeList(
      (await api.request('GET', 'patients/$p/prescriptions'))['prescriptions'],
      Prescription.fromJson);
  Future<Prescription> createPrescription(String p, Json body) async =>
      Prescription.fromJson((await api.request(
              'POST', 'patients/$p/prescriptions', body: body))['prescription']
          as Json);
  Future<void> closeMedicine(String p, String id, String status) async {
    await api
        .request('PATCH', 'patients/$p/items/$id', body: {'status': status});
  }

  Future<List<Schedule>> schedules(String p) async => decodeList(
      (await api.request('GET', 'patients/$p/schedules'))['schedules'],
      Schedule.fromJson);
  Future<void> addSchedule(String p, String item, Json body) async {
    await api.request('POST', 'patients/$p/items/$item/schedules', body: body);
  }

  Future<void> deactivateSchedule(String p, String id) async {
    await api.request('PATCH', 'patients/$p/schedules/$id',
        body: {'is_active': false});
  }

  Future<void> generateDoses(String p) async {
    await api
        .request('POST', 'patients/$p/doses/generate', body: {'days_ahead': 7});
  }

  Future<List<Dose>> doses(String p, String date) async => decodeList(
      (await api.request('GET', 'patients/$p/doses',
          query: {'from': date, 'to': date}))['doses'],
      Dose.fromJson);
  Future<void> confirmDose(String p, String id, String status) async {
    await api
        .request('PATCH', 'patients/$p/doses/$id', body: {'status': status});
  }

  Future<List<Conflict>> conflicts(String p, {String status = 'open'}) async =>
      decodeList(
          (await api.request('GET', 'patients/$p/conflicts',
              query: {'status': status}))['conflicts'],
          Conflict.fromJson);
  Future<void> checkConflicts(String p) async {
    await api.request('POST', 'patients/$p/conflicts/check', body: {});
  }

  Future<void> closeConflict(String p, String id, String status) async {
    await api.request('PATCH', 'patients/$p/conflicts/$id',
        body: {'status': status});
  }

  Future<List<Caregiver>> caregivers(String p) async => decodeList(
      (await api.request('GET', 'patients/$p/access'))['access'],
      Caregiver.fromJson);
  Future<void> invite(String p, String email, String role) async {
    await api.request('POST', 'patients/$p/invites',
        body: {'email': email, 'role': role});
  }

  Future<void> revoke(String p, String id) async {
    await api.request('DELETE', 'patients/$p/access/$id');
  }
}
