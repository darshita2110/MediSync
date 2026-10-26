import 'package:flutter/material.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'shared.dart';

class WeekdayPicker extends StatelessWidget {
  const WeekdayPicker(
      {super.key,
      required this.daily,
      required this.days,
      required this.onDaily,
      required this.onDay});
  final bool daily;
  final Set<int> days;
  final void Function(bool) onDaily;
  final void Function(int, bool) onDay;
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 8, children: [
          ChoiceChip(
              label: const Text('Every day'),
              selected: daily,
              onSelected: (_) => onDaily(true)),
          ChoiceChip(
              label: const Text('Selected days'),
              selected: !daily,
              onSelected: (_) => onDaily(false))
        ]),
        if (!daily) ...[
          const SizedBox(height: 8),
          Wrap(spacing: 7, runSpacing: 6, children: [
            for (var d = 0; d < 7; d++)
              FilterChip(
                  label: Text(weekdayLabels[d]),
                  selected: days.contains(d),
                  onSelected: (value) => onDay(d, value))
          ])
        ],
      ]);
}

class ScheduleDialog extends StatefulWidget {
  const ScheduleDialog(
      {super.key,
      required this.repo,
      required this.patient,
      required this.medicine});
  final Repository repo;
  final Patient patient;
  final Medicine medicine;
  @override
  State<ScheduleDialog> createState() => _ScheduleDialogState();
}

class _ScheduleDialogState extends State<ScheduleDialog> {
  final form = GlobalKey<FormState>();
  TimeOfDay? time;
  late DateTime start;
  DateTime? end;
  bool daily = true, busy = false;
  final Set<int> days = {1, 2, 3, 4, 5};
  String? error;
  @override
  void initState() {
    super.initState();
    final now = patientNow(widget.patient.timezone);
    final today = DateTime(now.year, now.month, now.day);
    final medicineStart = DateTime.parse(widget.medicine.startDate);
    start = medicineStart.isAfter(today) ? medicineStart : today;
    end = widget.medicine.endDate == null
        ? null
        : DateTime.parse(widget.medicine.endDate!);
  }

  Future<void> save() async {
    if (time == null) {
      setState(() => error = 'Choose a dose time.');
      return;
    }
    if (!daily && days.isEmpty) {
      setState(() => error = 'Choose at least one day.');
      return;
    }
    if (end != null && end!.isBefore(start)) {
      setState(
          () => error = 'The end date must be on or after the start date.');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final selected = time!;
      await widget.repo.addSchedule(widget.patient.id, widget.medicine.id, {
        'time_of_day':
            '${selected.hour.toString().padLeft(2, '0')}:${selected.minute.toString().padLeft(2, '0')}',
        'days_of_week': daily ? <int>[] : (days.toList()..sort()),
        'start_date': dateKey(start),
        'end_date': end == null ? null : dateKey(end!),
      });
      String? warning;
      try {
        await widget.repo.generateDoses(widget.patient.id);
      } catch (_) {
        warning =
            'Dose time saved. Refresh the timeline when the connection returns.';
      }
      if (mounted) Navigator.pop(context, warning ?? 'Dose time added.');
    } catch (e) {
      if (mounted) setState(() => error = friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormDialog(
          title: 'Add a dose time',
          subtitle: widget.medicine.name,
          formKey: form,
          busy: busy,
          error: error,
          onSave: save,
          saveLabel: 'Save dose time',
          children: [
            OutlinedButton.icon(
                onPressed: () async {
                  final result = await showTimePicker(
                      context: context,
                      initialTime: time ?? const TimeOfDay(hour: 8, minute: 0));
                  if (result != null && mounted) setState(() => time = result);
                },
                icon: const Icon(Icons.schedule),
                label: Text(
                    time == null ? 'Choose a time' : time!.format(context))),
            WeekdayPicker(
                daily: daily,
                days: days,
                onDaily: (value) => setState(() => daily = value),
                onDay: (day, selected) => setState(() {
                      selected ? days.add(day) : days.remove(day);
                    })),
            DateField(
                label: 'Start date',
                value: start,
                clearable: false,
                first: DateTime.parse(widget.medicine.startDate),
                last: widget.medicine.endDate == null
                    ? null
                    : DateTime.parse(widget.medicine.endDate!),
                onChanged: (value) => setState(() => start = value!)),
            DateField(
                label: 'End date (optional)',
                value: end,
                first: start,
                last: widget.medicine.endDate == null
                    ? null
                    : DateTime.parse(widget.medicine.endDate!),
                onChanged: (value) => setState(() => end = value)),
          ]);
}
