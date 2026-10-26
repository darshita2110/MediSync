import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:medisync/calendar.dart';
import 'package:medisync/models.dart';

class FakeServer {
  FakeServer({this.role = 'owner'});
  static const patientId = '10000000-0000-0000-0000-000000000001';
  static const medicineId = '20000000-0000-0000-0000-000000000001';
  final String role;
  bool unauthorized = false, conflictOnConfirm = false, failSchedules = false;
  final requests = <http.Request>[];
  final additionalMedicines = <Json>[];
  String doseStatus = 'pending';
  DateTime? doseTime, snoozedUntil;
  bool alertRead = false, workerAvailable = true;
  String get today => dateKey(patientNow('Asia/Kolkata'));
  Json get patient => {
        'id': patientId,
        'full_name': 'Asha Rao',
        'timezone': 'Asia/Kolkata',
        'role': role,
        'date_of_birth': '1958-03-15'
      };
  Json get medicine => {
        'id': medicineId,
        'raw_text': 'Example medicine',
        'dose_amount': '1 tablet as recorded',
        'status': 'active',
        'start_date': today,
        'end_date': null,
        'prescriber_name': 'Dr. Mehta',
        'frequency': 'Daily as recorded'
      };
  Json get dose => {
        'id': 'dose-1',
        'medicine': 'Example medicine',
        'dose_amount': '1 tablet as recorded',
        'status': doseStatus,
        'is_actionable': doseStatus == 'pending' || doseStatus == 'missed',
        'scheduled_for':
            doseTime?.toUtc().toIso8601String() ?? '${today}T02:30:00Z',
        'snoozed_until': snoozedUntil?.toUtc().toIso8601String(),
        'confirmed_at': doseStatus == 'pending' || doseStatus == 'missed'
            ? null
            : DateTime.now().toUtc().toIso8601String(),
        'confirmed_by_name':
            doseStatus == 'pending' || doseStatus == 'missed' ? null : 'Priya'
      };

  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    http.Response respond(Json value, [int status = 200]) =>
        http.Response(jsonEncode(value), status,
            headers: {'content-type': 'application/json'});
    final path = request.url.path;
    final body = request.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(request.body) as Json;
    if (path.contains('/auth/')) {
      return respond({
        'token': 'test-token',
        'user': {'id': 'user-1', 'name': 'Priya', 'email': 'priya@example.com'}
      });
    }
    if (unauthorized) return respond({'error': 'Expired'}, 401);
    if (path == '/api/notifications') {
      return respond({
        'notifications': [
          {
            ...dose,
            'id': 'alert-1',
            'dose_id': 'dose-1',
            'patient_id': patientId,
            'patient_name': 'Asha Rao',
            'timezone': 'Asia/Kolkata',
            'role': role,
            'kind': doseStatus == 'missed' ? 'missed' : 'reminder',
            'created_at': DateTime.now().toUtc().toIso8601String(),
            'read_at':
                alertRead ? DateTime.now().toUtc().toIso8601String() : null
          }
        ],
        'next_before': null,
        'delivery': {
          'push_configured': false,
          'last_completed_at':
              workerAvailable ? DateTime.now().toUtc().toIso8601String() : null
        },
      });
    }
    if (path.endsWith('/read')) {
      alertRead = true;
      return respond({
        'notification': {'id': 'alert-1'}
      });
    }
    if (path.endsWith('/snooze')) {
      if (conflictOnConfirm) {
        doseStatus = 'taken';
        return respond({
          'error': 'Already taken',
          'dose': {'status': 'taken', 'confirmed_by_name': 'Priya'}
        }, 409);
      }
      snoozedUntil = DateTime.now().add(const Duration(minutes: 10));
      return respond({'dose': dose});
    }
    if (path == '/api/patients') {
      if (request.method == 'POST') {
        return respond({
          'patient': {...patient, ...body, 'id': 'new-patient', 'role': 'owner'}
        }, 201);
      }
      return respond({
        'patients': [patient]
      });
    }
    if (path == '/api/invites') return respond({'invites': <Json>[]});
    if (path.endsWith('/prescribers')) {
      return respond({
        'prescribers': [
          {
            'id': 'doctor-1',
            'name': 'Dr. Mehta',
            'specialty': 'General physician'
          }
        ]
      });
    }
    if (path.endsWith('/items')) {
      return respond({
        'items': [medicine, ...additionalMedicines]
      });
    }
    if (path.endsWith('/prescriptions')) {
      if (request.method == 'POST') {
        final items = (body['items'] as List<dynamic>).cast<Json>();
        final saved = [
          for (var i = 0; i < items.length; i++)
            {...items[i], 'id': 'new-item-$i', 'status': 'active'}
        ];
        additionalMedicines.addAll(saved);
        return respond({
          'prescription': {
            'id': 'new-prescription',
            'visit_date': body['visit_date'],
            'notes': body['notes'],
            'items': saved
          }
        }, 201);
      }
      return respond({
        'prescriptions': [
          {
            'id': 'visit-1',
            'visit_date': today,
            'prescriber_name': 'Dr. Mehta',
            'items': [medicine]
          }
        ]
      });
    }
    if (path.endsWith('/schedules')) {
      if (request.method == 'POST') {
        return failSchedules
            ? respond({'error': 'Synthetic schedule failure'}, 500)
            : respond({'schedule': <String, dynamic>{}}, 201);
      }
      return respond({'schedules': <Json>[]});
    }
    if (path.endsWith('/doses/generate')) {
      return respond({'schedules_processed': 1, 'doses_created': 0});
    }
    if (path.endsWith('/doses')) {
      return respond({
        'doses': [dose]
      });
    }
    if (path.contains('/doses/') && request.method == 'PATCH') {
      doseStatus = conflictOnConfirm ? 'taken' : body['status'] as String;
      return conflictOnConfirm
          ? respond({
              'error': 'Already taken',
              'dose': {'status': 'taken', 'confirmed_by_name': 'Priya'}
            }, 409)
          : respond({'dose': dose});
    }
    if (path.endsWith('/conflicts')) return respond({'conflicts': <Json>[]});
    if (path.endsWith('/access')) {
      return respond({
        'access': [
          {
            'id': 'access-1',
            'user_id': 'user-1',
            'email': 'priya@example.com',
            'name': 'Priya',
            'role': 'owner',
            'status': 'accepted'
          }
        ]
      });
    }
    return respond(
        {'error': 'Unexpected fixture request: ${request.method} $path'}, 404);
  }
}
