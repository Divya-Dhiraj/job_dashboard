// legacy_divya_seed.js — One-time seed used by database.js migration.
// Mirrors the constants that lived in the original matcher.js so that on
// first boot of the multi-profile schema, Divya Dhiraj's profile is created
// with exactly the same scoring behavior as before.
//
// Safe to delete after migration has run on every install you care about.

module.exports = {
  slug: 'divya-dhiraj',
  name: 'Divya Dhiraj',
  email: 'divyadhiraj.div@gmail.com',
  phone: '+49 176 10813544',
  address: 'Munich, Germany',
  linkedin: 'linkedin.com/in/divya-dhiraj',
  notify_email: '',  // pulled from env at migration time

  allowed_country_codes: ['de'],

  search_titles: [
    'Business Intelligence Engineer',
    'BI Developer',
    'Data Analyst',
    'Analytics Engineer',
    'Data Engineer',
    'SAP BI Consultant',
    'Power BI Developer',
    'Reporting Analyst',
    'Business Analyst',
    'Data Scientist',
  ],

  target_titles: [
    'Business Intelligence Engineer', 'BI Engineer',
    'Business Intelligence Developer', 'BI Developer',
    'Business Intelligence Analyst', 'BI Analyst',
    'Reporting Analyst', 'Analytics Engineer',
    'Data Analyst', 'Senior Data Analyst',
    'Data Engineer', 'Data Platform Engineer',
    'Data Warehouse Engineer', 'ETL Developer', 'Data Scientist',
    'SAP BI Consultant', 'SAP BW Consultant',
    'SAP Analytics Consultant', 'SAP Data Analyst',
    'Power BI Developer', 'Power BI Analyst',
    'Tableau Developer', 'SQL Developer',
    'Business Analyst', 'Product Analyst',
  ],

  skill_groups: {
    core_bi: {
      weight: 4,
      skills: [
        'business intelligence', 'bi engineer', 'bi developer', 'bi analyst', 'bi consultant',
        'data analyst', 'data analytics', 'analytics engineer', 'reporting analyst',
        'sql', 'redshift', 'quicksight', 'power bi', 'powerbi', 'tableau', 'looker',
        'qlik', 'microstrategy', 'thoughtspot', 'sisense',
        'etl', 'data pipeline', 'data modeling', 'data modelling', 'data warehouse',
        'data mart', 'data lake', 'data lakehouse', 'reporting', 'dashboard', 'kpi',
        'analytics', 'metrics', 'ad hoc', 'olap', 'oltp', 'dimensional modelling',
      ],
    },
    sap: {
      weight: 4,
      skills: [
        'sap', 'sap bw', 'sap bw/4hana', 'bw4hana', 'sap s/4hana', 's4hana', 'sap hana',
        'sap hana db', 'bobj', 'bods', 'webi', 'sac', 'sap analytics cloud',
        'sap abap', 'abap', 'sap analyst', 'sap consultant', 'sap bi',
        'analysis for office', 'afo', 'sap datasphere', 'sap cdp',
      ],
    },
    cloud_modern_stack: {
      weight: 3,
      skills: [
        'aws', 'amazon web services', 's3', 'redshift', 'glue', 'athena', 'emr',
        'azure', 'azure synapse', 'azure data factory', 'adf', 'azure databricks',
        'google cloud', 'gcp', 'bigquery', 'google bigquery',
        'snowflake', 'databricks', 'dbt', 'spark', 'apache spark',
        'airflow', 'apache airflow', 'kafka', 'data build tool',
      ],
    },
    python_data_science: {
      weight: 3,
      skills: [
        'python', 'pandas', 'numpy', 'matplotlib', 'plotly', 'seaborn',
        'data science', 'data visualization', 'machine learning', 'ai', 'nlp',
        'llm', 'large language model', 'generative ai', 'gen ai',
        'fastapi', 'streamlit', 'langchain', 'langgraph',
        'postgresql', 'postgres', 'mysql', 'oracle', 'oracle sql',
        'scikit-learn', 'tensorflow', 'pytorch', 'statistics',
      ],
    },
    dev_tools: {
      weight: 2,
      skills: [
        'c#', 'java', 'sql server', 'matlab', 'erp',
        'jira', 'confluence', 'agile', 'scrum', 'git', 'github', 'gitlab',
        'excel', 'sharepoint', 'power automate', 'ms office',
        'docker', 'kubernetes', 'ci/cd', 'rest api', 'api',
      ],
    },
    soft_domain: {
      weight: 1,
      skills: [
        'product management', 'stakeholder', 'cross-functional', 'requirements gathering',
        'roadmap', 'business requirements', 'technical requirements', 'uat',
        'logistics', 'supply chain', 'e-commerce', 'after market', 'last mile',
      ],
    },
  },
};
