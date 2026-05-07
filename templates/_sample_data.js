// Shared sample CV data used to render all template previews.
// Generic placeholder profile — densely filled so the user can judge
// how each template handles real-world content volume on a single page.
module.exports = {
  // Personal / contact
  name: 'Sample Candidate',
  targetTitle: 'Senior Data Engineer',
  email: 'sample.candidate@example.com',
  phone: '+49 151 12345678',
  address: 'Munich, Germany',
  linkedin: 'linkedin.com/in/sample-candidate',
  github: 'github.com/sample-candidate',

  // German-specific (shown only when template asks for them)
  dob: '14.03.1992',
  place_of_birth: 'Hyderabad, India',
  nationality: 'Indian',
  marital_status: 'Single',

  // 2-3 sentence summary, dense
  profileSummary: 'Senior data engineer with 7+ years building cloud-native analytics platforms across logistics, fintech and SaaS. Owns end-to-end pipelines from ingestion through warehouse modeling to BI delivery, with a track record of cutting reporting latency by 40-60% and warehouse spend by 30%+. Comfortable embedded with product, finance and ops teams.',

  experience: [
    {
      title: 'Senior Data Engineer',
      company: 'Northwind Logistics GmbH',
      location: 'Munich, Germany',
      dates: 'Mar 2023 – Present',
      bullets: [
        'Re-architected the warehouse layer (Snowflake → dbt) supporting 120+ analytics models, cut average reporting latency from 8 min to under 2.',
        'Designed event ingestion via Kafka + Debezium for 14 microservices; replaced batch ETL that ran nightly with sub-minute CDC.',
        'Reduced Snowflake compute spend 32% through warehouse right-sizing, query optimization and clustering keys; documented patterns now used by 4 sister teams.',
        'Hired and onboarded 2 data engineers; introduced a code-review and CI gate for dbt models that cut prod incidents related to schema changes by ~70%.',
      ],
    },
    {
      title: 'Data Engineer',
      company: 'Cloover Energy',
      location: 'Berlin, Germany',
      dates: 'Aug 2021 – Feb 2023',
      bullets: [
        'Built the BI foundation from scratch: Airflow + Postgres → Redshift → Looker, serving finance, product and ops with 60+ executive dashboards.',
        'Implemented row-level security and SSO across the BI stack; cleared SOC 2 Type II audit on first attempt.',
        'Owned the data contract layer between platform and analytics; reduced "broken dashboard" tickets by 65% YoY.',
      ],
    },
    {
      title: 'Analytics Engineer',
      company: 'JustPlay (Mobile Gaming)',
      location: 'Berlin, Germany',
      dates: 'Sep 2019 – Jul 2021',
      bullets: [
        'Owned LTV / retention / monetization analytics for a 5M MAU app; integrated AppsFlyer, RevenueCat, internal events.',
        'Built an A/B experimentation framework on top of BigQuery + dbt; ran 80+ tests in 18 months, materially shaping the new-user funnel.',
      ],
    },
    {
      title: 'BI Analyst',
      company: 'Almedia',
      location: 'Hyderabad, India',
      dates: 'Jul 2017 – Aug 2019',
      bullets: [
        'Standardized reporting across 6 product lines using Power BI + SQL Server; saved analysts ~12 hours/week of manual exports.',
        'Built first cohort & churn dashboards; outputs adopted as the weekly leadership review.',
      ],
    },
  ],

  education: [
    { degree: 'M.Sc. Information Systems', school: 'Technische Universität München', dates: '2019 – 2021', details: 'Thesis: streaming event modeling for last-mile logistics. Grade: 1.7.' },
    { degree: 'B.Eng. Computer Science',    school: 'Osmania University, Hyderabad', dates: '2013 – 2017', details: 'GPA 3.7/4.0; data systems track.' },
  ],

  skills: {
    'Languages':            ['SQL', 'Python', 'TypeScript', 'Bash'],
    'Data & Warehouse':     ['dbt', 'Snowflake', 'BigQuery', 'Redshift', 'Postgres', 'Spark', 'Kafka', 'Debezium'],
    'Orchestration & Cloud':['Airflow', 'AWS (S3, Glue, Athena, Lambda)', 'GCP (BigQuery, Cloud Run)', 'Docker', 'Terraform'],
    'BI & Visualization':   ['Looker', 'Power BI', 'Tableau', 'Metabase'],
    'Methodologies':        ['Dimensional modeling', 'Data contracts', 'CI/CD for data', 'Agile / Scrum'],
  },

  certifications: [
    'AWS Certified Data Analytics — Specialty (2023)',
    'dbt Analytics Engineering Certified (2024)',
    'Google Professional Data Engineer (2022)',
  ],

  languages: [
    { lang: 'English', level: 'C2 (near-native)' },
    { lang: 'German',  level: 'B2 (upper-intermediate)' },
    { lang: 'Telugu',  level: 'Native' },
    { lang: 'Hindi',   level: 'C1' },
  ],

  // Optional photo (data URL) — null in samples; signup wizard fills this
  photoDataUrl: null,
};
