import 'package:flutter/material.dart';
import '../api.dart';
import '../models.dart';
import '../session.dart';
import '../push.dart';
import 'push_settings_page.dart';
import 'basic_forms.dart';
import 'alerts_page.dart';
import 'patient_page.dart';
import 'shared.dart';

class PatientsPage extends StatefulWidget {
  const PatientsPage({super.key, required this.controller, this.push});
  final SessionController controller;
  final PushController? push;
  @override
  State<PatientsPage> createState() => _PatientsPageState();
}

class _PatientsPageState extends State<PatientsPage> {
  late Future<(List<Patient>, List<Invite>)> future;
  bool signingOut = false;
  Repository get repo => widget.controller.repository;
  @override
  void initState() {
    super.initState();
    future = load();
  }

  Future<(List<Patient>, List<Invite>)> load() async {
    final result = await Future.wait<Object>([repo.patients(), repo.invites()]);
    return (result[0] as List<Patient>, result[1] as List<Invite>);
  }

  Future<void> refresh() async {
    setState(() {
      future = load();
    });
    try {
      await future;
    } catch (_) {/* Displayed by AsyncSection. */}
  }

  Future<void> addPatient() async {
    if (await showDialog<bool>(
                context: context,
                barrierDismissible: false,
                builder: (_) => NewPatientDialog(repo: repo)) ==
            true &&
        mounted) {
      await refresh();
    }
  }

  Future<void> open(Patient patient) async {
    await Navigator.push<void>(
        context,
        MaterialPageRoute(
            builder: (_) => PatientPage(patient: patient, repo: repo)));
    if (mounted) await refresh();
  }

  Future<void> signOut() async {
    setState(() => signingOut = true);
    try {
      await widget.controller.signOut();
    } catch (e) {
      if (mounted) notice(context, friendlyError(e));
    } finally {
      if (mounted) setState(() => signingOut = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
      appBar: AppBar(
          toolbarHeight: 80,
          title:
              const Padding(padding: EdgeInsets.only(left: 4), child: Brand()),
          actions: [
            if (widget.push != null)
              IconButton(
                  tooltip: 'Phone notifications',
                  onPressed: () => Navigator.push<void>(
                      context,
                      MaterialPageRoute(
                          builder: (_) =>
                              PushSettingsPage(push: widget.push!))),
                  icon: const Icon(Icons.notifications_active_outlined)),
            IconButton(
                tooltip: 'Care alerts',
                onPressed: () => Navigator.push<void>(context,
                    MaterialPageRoute(builder: (_) => AlertsPage(repo: repo))),
                icon: const Icon(Icons.notifications_none)),
            IconButton(
                tooltip: 'Refresh care spaces',
                onPressed: refresh,
                icon: const Icon(Icons.refresh)),
            Padding(
                padding: const EdgeInsets.only(right: 12),
                child: IconButton(
                    tooltip: 'Sign out',
                    onPressed: signingOut ? null : signOut,
                    icon: const Icon(Icons.logout))),
          ]),
      body: ContentList(onRefresh: refresh, children: [
        const SizedBox(height: 20),
        Text('YOUR CARE CIRCLE',
            style: TextStyle(
                color: teal,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.5)),
        const SizedBox(height: 12),
        Text('Care, kept in sync.',
            style: Theme.of(context).textTheme.headlineLarge),
        const SizedBox(height: 10),
        Text(
            'Hello, ${widget.controller.session!.name}. Choose a patient to see their shared care plan.'),
        const SizedBox(height: 30),
        AsyncSection(
            future: future,
            retry: refresh,
            builder: (data) => Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SectionTitle('Your patients',
                          subtitle:
                              '${data.$1.length} care ${data.$1.length == 1 ? 'space' : 'spaces'}',
                          action: FilledButton.icon(
                              onPressed: addPatient,
                              icon: const Icon(Icons.add),
                              label: const Text('Add patient'))),
                      if (data.$1.isEmpty)
                        EmptyState(
                            title: 'Create your first care space',
                            message:
                                'Add yourself or someone you care for, then bring their prescriptions and caregivers together.',
                            icon: Icons.person_add_alt_1_outlined,
                            action: FilledButton(
                                onPressed: addPatient,
                                child: const Text('Add a patient')))
                      else
                        LayoutBuilder(builder: (context, constraints) {
                          final count = constraints.maxWidth >= 900
                              ? 3
                              : constraints.maxWidth >= 570
                                  ? 2
                                  : 1;
                          final width =
                              (constraints.maxWidth - (count - 1) * 16) / count;
                          return Wrap(spacing: 16, runSpacing: 16, children: [
                            for (final patient in data.$1)
                              SizedBox(
                                  width: width,
                                  child: Semantics(
                                      button: true,
                                      label:
                                          'Open ${patient.name}, ${patient.role.label}',
                                      child: InkWell(
                                          onTap: () => open(patient),
                                          borderRadius:
                                              BorderRadius.circular(20),
                                          child: Panel(
                                              child: Column(
                                                  crossAxisAlignment:
                                                      CrossAxisAlignment.start,
                                                  children: [
                                                Row(children: [
                                                  const CircleAvatar(
                                                      radius: 24,
                                                      backgroundColor:
                                                          Color(0xFFE6EFE5),
                                                      child: Icon(
                                                          Icons.person_outline,
                                                          color: teal)),
                                                  const SizedBox(width: 12),
                                                  Expanded(
                                                      child: Align(
                                                          alignment: Alignment
                                                              .centerRight,
                                                          child: StatusBadge(
                                                              patient
                                                                  .role.label)))
                                                ]),
                                                const SizedBox(height: 24),
                                                Text(patient.name,
                                                    style: Theme.of(context)
                                                        .textTheme
                                                        .titleLarge),
                                                const SizedBox(height: 7),
                                                Text(patient.timezone
                                                    .replaceAll('_', ' ')),
                                                const SizedBox(height: 24),
                                                const Row(children: [
                                                  Expanded(
                                                      child: Text(
                                                          'Open care space',
                                                          style: TextStyle(
                                                              color: teal,
                                                              fontWeight:
                                                                  FontWeight
                                                                      .w600))),
                                                  Icon(
                                                      Icons
                                                          .arrow_forward_rounded,
                                                      color: teal,
                                                      size: 20)
                                                ]),
                                              ])))))
                          ]);
                        }),
                      if (data.$2.isNotEmpty) ...[
                        const SizedBox(height: 36),
                        const SectionTitle('Invitations',
                            subtitle:
                                'Join a care space only when you accept.'),
                        for (final invite in data.$2)
                          Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Panel(
                                  child: Wrap(
                                      alignment: WrapAlignment.spaceBetween,
                                      spacing: 20,
                                      runSpacing: 16,
                                      crossAxisAlignment:
                                          WrapCrossAlignment.center,
                                      children: [
                                    Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(invite.patientName,
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .titleMedium),
                                          Text(
                                              'Invited as ${invite.role.label.toLowerCase()}')
                                        ]),
                                    RunButton(
                                        label: 'Accept invitation',
                                        run: () async {
                                          await repo.acceptInvite(invite.id);
                                          if (mounted) await refresh();
                                        }),
                                  ])))
                      ],
                    ])),
        const SizedBox(height: 30),
      ]));
}
