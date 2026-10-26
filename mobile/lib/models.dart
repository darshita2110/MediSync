typedef Json = Map<String, dynamic>;

List<T> decodeList<T>(Object? value, T Function(Json) decode) =>
    (value as List<dynamic>).map((row) => decode(row as Json)).toList();

enum PatientRole {
  owner('Owner'),
  familyAdmin('Family admin'),
  helper('Helper'),
  viewer('Viewer');

  const PatientRole(this.label);
  final String label;
  static PatientRole parse(String value) => switch (value) {
        'owner' => owner,
        'family_admin' => familyAdmin,
        'helper' => helper,
        _ => viewer,
      };
  bool get canManage => this == owner || this == familyAdmin;
  bool get canReadRecords => this != helper;
  bool get canConfirm => this != viewer;
}

class Session {
  const Session(
      {required this.token,
      required this.userId,
      required this.email,
      required this.name});
  factory Session.fromJson(Json data) {
    final user = data['user'] as Json;
    return Session(
        token: data['token'] as String,
        userId: user['id'] as String,
        email: user['email'] as String,
        name: user['name'] as String? ?? 'Caregiver');
  }
  final String token, userId, email, name;
  Json toJson() => {
        'token': token,
        'user': {'id': userId, 'email': email, 'name': name}
      };
}

class Patient {
  const Patient(
      {required this.id,
      required this.name,
      required this.timezone,
      required this.role,
      this.birthDate});
  factory Patient.fromJson(Json data) => Patient(
      id: data['id'] as String,
      name: data['full_name'] as String,
      timezone: data['timezone'] as String,
      role: PatientRole.parse(data['role'] as String? ?? 'viewer'),
      birthDate: data['date_of_birth'] as String?);
  final String id, name, timezone;
  final PatientRole role;
  final String? birthDate;
}

class Doctor {
  const Doctor(
      {required this.id,
      required this.name,
      this.specialty,
      this.clinic,
      this.phone});
  factory Doctor.fromJson(Json data) => Doctor(
      id: data['id'] as String,
      name: data['name'] as String,
      specialty: data['specialty'] as String?,
      clinic: data['clinic'] as String?,
      phone: data['phone'] as String?);
  final String id, name;
  final String? specialty, clinic, phone;
}

class Medicine {
  const Medicine(
      {required this.id,
      required this.name,
      required this.dose,
      required this.status,
      required this.startDate,
      this.endDate,
      this.brand,
      this.ingredient,
      this.strength,
      this.frequency,
      this.doctor});
  factory Medicine.fromJson(Json data) => Medicine(
      id: data['id'] as String,
      name: data['raw_text'] as String,
      dose: data['dose_amount'] as String,
      status: data['status'] as String,
      startDate: data['start_date'] as String,
      endDate: data['end_date'] as String?,
      brand: data['brand_name'] as String?,
      ingredient: data['ingredient'] as String?,
      strength: data['strength'] as String?,
      frequency: data['frequency'] as String?,
      doctor: data['prescriber_name'] as String?);
  final String id, name, dose, status, startDate;
  final String? endDate, brand, ingredient, strength, frequency, doctor;
}

class Prescription {
  const Prescription(
      {required this.id,
      required this.visitDate,
      required this.items,
      this.doctor,
      this.notes});
  factory Prescription.fromJson(Json data) => Prescription(
      id: data['id'] as String,
      visitDate: data['visit_date'] as String,
      items: decodeList(
          data['items'],
          (item) => Medicine.fromJson({
                ...item,
                'prescriber_name':
                    item['prescriber_name'] ?? data['prescriber_name']
              })),
      doctor: data['prescriber_name'] as String?,
      notes: data['notes'] as String?);
  final String id, visitDate;
  final String? doctor, notes;
  final List<Medicine> items;
}

class Dose {
  const Dose(
      {required this.id,
      required this.medicine,
      required this.amount,
      required this.scheduledFor,
      required this.status,
      required this.actionable,
      this.remindersSent = 0,
      this.snoozedUntil,
      this.confirmedBy,
      this.confirmedAt});
  factory Dose.fromJson(Json data) => Dose(
      id: data['id'] as String,
      medicine: data['medicine'] as String,
      amount: data['dose_amount'] as String,
      scheduledFor: DateTime.parse(data['scheduled_for'] as String),
      status: data['status'] as String,
      actionable: data['is_actionable'] as bool? ?? false,
      remindersSent: data['reminders_sent'] as int? ?? 0,
      snoozedUntil: data['snoozed_until'] == null
          ? null
          : DateTime.parse(data['snoozed_until'] as String),
      confirmedBy: data['confirmed_by_name'] as String?,
      confirmedAt: data['confirmed_at'] == null
          ? null
          : DateTime.parse(data['confirmed_at'] as String));
  final String id, medicine, amount, status;
  final DateTime scheduledFor;
  final bool actionable;
  final String? confirmedBy;
  final DateTime? confirmedAt;
  final int remindersSent;
  final DateTime? snoozedUntil;
  bool get canSnooze =>
      actionable &&
      status == 'pending' &&
      remindersSent < 3 &&
      !scheduledFor.isAfter(DateTime.now()) &&
      DateTime.now().isBefore(scheduledFor.add(const Duration(minutes: 45)));
}

class CareAlert {
  CareAlert.fromJson(Json data)
      : id = data['id'] as String,
        kind = data['kind'] as String,
        createdAt = DateTime.parse(data['created_at'] as String),
        isRead = data['read_at'] != null,
        patient = Patient.fromJson({
          ...data,
          'id': data['patient_id'],
          'full_name': data['patient_name']
        }),
        dose = Dose.fromJson({...data, 'id': data['dose_id']});
  final String id, kind;
  final DateTime createdAt;
  final bool isRead;
  final Patient patient;
  final Dose dose;
}

class AlertPage {
  AlertPage.fromJson(Json data)
      : alerts = decodeList(data['notifications'], CareAlert.fromJson),
        nextBefore = data['next_before'] as String?,
        lastWorkerTick = (data['delivery'] as Json)['last_completed_at'] == null
            ? null
            : DateTime.parse(
                (data['delivery'] as Json)['last_completed_at'] as String);
  final List<CareAlert> alerts;
  final String? nextBefore;
  final DateTime? lastWorkerTick;
  bool get workerRecent =>
      lastWorkerTick != null &&
      DateTime.now().difference(lastWorkerTick!) < const Duration(minutes: 3);
}

class Schedule {
  const Schedule(
      {required this.id,
      required this.itemId,
      required this.time,
      required this.days,
      required this.startDate,
      this.endDate});
  factory Schedule.fromJson(Json data) => Schedule(
      id: data['id'] as String,
      itemId: data['prescription_item_id'] as String,
      time: data['time_of_day'] as String,
      days: (data['days_of_week'] as List<dynamic>).cast<int>(),
      startDate: data['start_date'] as String,
      endDate: data['end_date'] as String?);
  final String id, itemId, time, startDate;
  final List<int> days;
  final String? endDate;
}

class Conflict {
  const Conflict(
      {required this.id,
      required this.kind,
      required this.description,
      required this.status,
      required this.level});
  factory Conflict.fromJson(Json data) => Conflict(
      id: data['id'] as String,
      kind: data['kind'] as String,
      description: data['description'] as String,
      status: data['status'] as String,
      level: data['level'] as int);
  final String id, kind, description, status;
  final int level;
  String get title => switch (kind) {
        'duplicate_medicine' => 'Possible duplicate medicine',
        'same_ingredient' => 'Same recorded ingredient',
        'different_instructions' => 'Instructions need clarification',
        'course_ended' => 'Course date needs review',
        _ => 'Prescription needs review',
      };
}

class Caregiver {
  const Caregiver(
      {required this.id,
      required this.userId,
      required this.email,
      required this.role,
      required this.status,
      this.name});
  factory Caregiver.fromJson(Json data) => Caregiver(
      id: data['id'] as String,
      userId: data['user_id'] as String,
      email: data['email'] as String,
      role: PatientRole.parse(data['role'] as String),
      status: data['status'] as String,
      name: data['name'] as String?);
  final String id, userId, email, status;
  final PatientRole role;
  final String? name;
}

class Invite {
  const Invite(
      {required this.id, required this.patientName, required this.role});
  factory Invite.fromJson(Json data) => Invite(
      id: data['id'] as String,
      patientName: data['patient_name'] as String,
      role: PatientRole.parse(data['role'] as String));
  final String id, patientName;
  final PatientRole role;
}
