// Exercise the actual Dart client against the isolated Node/PostgreSQL server.
// Start backend/test/support/client-server.js first. This refuses a normal API.
import 'dart:io';
import 'package:medisync/api.dart';

void check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> main() async {
  final api = ApiClient(baseUrl: Uri.parse('http://127.0.0.1:31328'));
  final helperApi = ApiClient(baseUrl: api.baseUrl);
  try {
    final scope =
        await api.request('GET', '__test_scope', authenticated: false);
    check(
        scope['isolated'] == true &&
            (scope['scope'] as String).startsWith('medisync_test_'),
        'Refusing to create QA data in a normal API');
    final repo = Repository(api);
    final helper = Repository(helperApi);
    const password = 'MediSync-qa-12345';
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final email = 'qa-owner-$stamp@example.test';
    final helperEmail = 'qa-helper-$stamp@example.test';
    final ownerSession = await repo.signup('Priya (QA)', email, password);
    api.token = ownerSession.token;
    helperApi.token =
        (await helper.signup('Helper (QA)', helperEmail, password)).token;
    final patient = await repo.createPatient({
      'full_name': 'Asha Rao (QA)',
      'timezone': 'Asia/Kolkata',
      'date_of_birth': '1958-03-15'
    });
    check(patient.birthDate == '1958-03-15',
        'Calendar date serialization changed');
    await repo.addDoctor(patient.id,
        {'name': 'Dr. Mehta (QA)', 'specialty': 'General physician'});
    final doctor = (await repo.doctors(patient.id)).single;
    final now =
        DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30));
    final date =
        '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    for (var i = 0; i < 2; i++) {
      await repo.createPrescription(patient.id, {
        'prescriber_id': doctor.id,
        'visit_date': date,
        'items': [
          {
            'raw_text': 'Example medicine (QA)',
            'brand_name': 'Example brand',
            'dose_amount':
                i == 0 ? '1 tablet as recorded' : '2 tablets as recorded',
            'start_date': date
          },
        ]
      });
    }
    final medicines = await repo.medicines(patient.id);
    check(medicines.length == 2, 'Prescription medicines were not returned');
    final conflicts = await repo.conflicts(patient.id);
    check(conflicts.length == 2,
        'Automatic duplicate/instruction review was not returned to the client');
    await repo.addSchedule(patient.id, medicines.first.id,
        {'time_of_day': '08:00', 'start_date': date});
    await repo.addSchedule(patient.id, medicines.last.id,
        {'time_of_day': '20:00', 'start_date': date});
    await repo.generateDoses(patient.id);
    var doses = await repo.doses(patient.id, date);
    check(doses.length == 2 && doses.every((d) => d.actionable),
        'Dose timeline or eligibility did not decode');
    await repo.invite(patient.id, helperEmail, 'helper');
    await helper.acceptInvite((await helper.invites()).single.id);
    check((await helper.patients()).single.role.label == 'Helper',
        'Accepted role was not returned');
    await helper.confirmDose(patient.id, doses.first.id, 'taken');
    try {
      await repo.confirmDose(patient.id, doses.first.id, 'skipped');
      throw StateError('A duplicate confirmation was accepted');
    } on ApiException catch (error) {
      check(error.status == 409,
          'Expected the duplicate confirmation to return 409');
    }
    doses = await repo.doses(patient.id, date);
    check(
        doses.first.status == 'taken' &&
            doses.first.confirmedBy == 'Helper (QA)',
        'The first confirmation was not preserved');
    check((await repo.prescriptions(patient.id)).length == 2,
        'Visit history did not decode');
    check((await repo.caregivers(patient.id)).length == 2,
        'Caregiver access did not decode');
    stdout.writeln(
        'PASS: real Dart client signup, patient, doctors, prescriptions, schedules, review, invites, consent and concurrent-dose handling.');
    stdout.writeln('Synthetic browser QA login: $email / $password');
  } finally {
    api.close();
    helperApi.close();
  }
}
