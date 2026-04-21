export const initialState = {
  isAuthenticated: false,
  user: null,
  branches: [
    {
      id: 'branch-1',
      name: 'Actis HQ',
      displays: [
        {
          id: 'display-1',
          name: 'Main Lobby Display',
          pages: {
            caseStudies: [
              {
                id: 'cs-1',
                category: 'Corporate',
                title: 'Digital Transformation for Enterprise',
                bulletPoints: [
                  'Reduced operational costs by 40%',
                  'Implemented cloud-first infrastructure',
                  'Achieved 99.9% uptime SLA',
                ],
                thumbnails: [],
                mainImage: null,
              },
              {
                id: 'cs-2',
                category: 'Healthcare',
                title: 'Smart Hospital Management System',
                bulletPoints: [
                  'Streamlined patient intake process',
                  'Real-time bed management dashboard',
                  'Integrated with existing EMR systems',
                ],
                thumbnails: [],
                mainImage: null,
              },
            ],
          },
        },
        {
          id: 'display-2',
          name: 'Conference Room A',
          pages: {
            caseStudies: [],
          },
        },
      ],
    },
    {
      id: 'branch-2',
      name: 'Actis Dubai',
      displays: [
        {
          id: 'display-3',
          name: 'Reception Display',
          pages: {
            caseStudies: [
              {
                id: 'cs-3',
                category: 'Retail',
                title: 'Omnichannel Retail Experience',
                bulletPoints: [
                  'Unified online and offline customer journey',
                  'AI-powered inventory management',
                  'Increased customer retention by 35%',
                ],
                thumbnails: [],
                mainImage: null,
              },
            ],
          },
        },
      ],
    },
  ],
};
